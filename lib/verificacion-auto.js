/**
 * Actualización automática de la Verificación Post-Envío.
 *
 * Qué hace: dos veces por día (HORARIOS, hora Argentina) repite la verificación de cada
 * período cuya ventana sigue abierta y guarda el resultado en el período
 * (data/periodos/<id>.json → verificacion, con actualizadoEn y origen:'auto').
 *
 * Ventana: un período M-YYYY (obleas que vencen en el mes M) se sigue actualizando hasta
 * el día DIA_CIERRE del mes siguiente inclusive. Ej: 9-2026 → hasta el 20/10/2026.
 *
 * Solo entran períodos que YA tienen una verificación guardada (alguien la corrió y apretó
 * 💾 al menos una vez). Así no se actualizan archivos de prueba ni períodos a medio armar.
 *
 * Cómo repite: igual que "re-analizar" en la pantalla → DELETE del job en dalegas + POST
 * con force:false. dalegas resuelve casi todo desde enargas_data (ES-21) y va a S14 solo
 * por lo que falte, así que no machaca ENARGAS. Si hay un job del período corriendo (alguien
 * lo lanzó a mano), esa corrida se saltea.
 */
const fs = require('fs');
const path = require('path');
const { clasificarItemLote } = require('./clasificar-lote');
const { leerPeriodo, listarPeriodos, actualizarVerificacion } = require('./storage');

const HORARIOS = ['07:45', '12:00'];      // ART. 07:45 = después del import InfoSys de las 07:30
const DIA_CIERRE = 20;                    // día del mes siguiente hasta el que se actualiza
const MARGEN_SLOT_MIN = 180;              // si el server estuvo caído, recupera el slot hasta 3h tarde
const POLL_MS = 20000;
const POLL_MAX_MS = 3 * 60 * 60 * 1000;   // un job con mucho S14 puede tardar
const MESES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const ESTADO_PATH = path.join(__dirname, '..', 'data', 'verificacion-auto.json');

// ── Fechas en hora Argentina (UTC-3 fijo, sin horario de verano) ──
function ahoraART() { return new Date(Date.now() - 3 * 3600 * 1000); } // leer siempre con getUTC*
function fechaART(d) { return d.toISOString().slice(0, 10); }

function nombreLegible(periodoId) {
  if (!periodoId || periodoId === 'sin-fecha') return 'Obleas sin fecha';
  const [mes, anio] = periodoId.split('-');
  return `Obleas ${MESES[parseInt(mes)] || mes} ${anio}`;
}

// Último día (YYYY-MM-DD) en que el período se actualiza, o null si el id no es M-YYYY.
function fechaCierre(periodoId) {
  const m = /^(\d{1,2})-(\d{4})$/.exec(periodoId || '');
  if (!m) return null;
  let mes = parseInt(m[1]) + 1, anio = parseInt(m[2]);
  if (mes > 12) { mes = 1; anio++; }
  return `${anio}-${String(mes).padStart(2, '0')}-${String(DIA_CIERRE).padStart(2, '0')}`;
}
// Abierta = el mes del período ya empezó y todavía no pasó el día de cierre.
// El "ya empezó" deja afuera períodos futuros a medio armar (ej. un 10-2026 de prueba
// guardado en mayo): no se actualizan ni se abren por defecto antes de su mes.
function ventanaAbierta(periodoId, hoy = fechaART(ahoraART())) {
  const cierre = fechaCierre(periodoId);
  return !!cierre && mesEmpezado(periodoId, hoy) && hoy <= cierre;
}
function mesEmpezado(periodoId, hoy = fechaART(ahoraART())) {
  const m = /^(\d{1,2})-(\d{4})$/.exec(periodoId || '');
  if (!m) return false;
  const inicio = `${m[2]}-${String(parseInt(m[1])).padStart(2, '0')}-01`;
  return hoy >= inicio;
}

function leerEstado() {
  try { return JSON.parse(fs.readFileSync(ESTADO_PATH, 'utf8')); } catch { return {}; }
}
function guardarEstado(e) {
  try { fs.writeFileSync(ESTADO_PATH, JSON.stringify(e, null, 2), 'utf8'); } catch (err) { console.error('[verif-auto] no pude guardar estado:', err.message); }
}

function crear({ dalegasUrl, dalegasKey, leerConfig, notificar }) {
  let corriendo = false;
  const estado = leerEstado(); // { ultimoSlot, corridas: { [periodoId]: {ok, en, msg} } }
  estado.corridas = estado.corridas || {};

  async function dalegas(metodo, ruta, body, timeoutMs = 120000) {
    const resp = await fetch(`${dalegasUrl}${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': dalegasKey },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await resp.json().catch(() => ({}));
    return { status: resp.status, ok: resp.ok, data };
  }

  function periodosElegibles() {
    return listarPeriodos()
      .filter(p => p.resumen && p.resumen.verificacion && ventanaAbierta(p.periodoId))
      .map(p => p.periodoId);
  }

  // Período que la pantalla abre por defecto: el más reciente (por mes, de los que ya
  // empezaron) con verificación guardada.
  function ultimoReporte() {
    const conVerif = listarPeriodos().filter(p => p.resumen && p.resumen.verificacion && mesEmpezado(p.periodoId));
    const clave = id => { const [m, a] = id.split('-'); return parseInt(a) * 100 + parseInt(m); };
    conVerif.sort((a, b) => clave(b.periodoId) - clave(a.periodoId));
    return conVerif.length ? conVerif[0].periodoId : null;
  }

  async function correrPeriodo(periodoId) {
    const periodo = leerPeriodo(periodoId);
    if (!periodo) throw new Error('período no encontrado');
    const registros = (periodo.registros || []).filter(r => r.UDOMINIO);
    if (!registros.length) throw new Error('el período no tiene registros');
    const nombre = nombreLegible(periodoId);
    const jobId = nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const patentes = registros.map(r => {
      const it = { patente: r.UDOMINIO };
      if (r.UOBLEANEW) it.oblea = parseInt(r.UOBLEANEW);
      return it;
    });

    // Si alguien está corriendo este período a mano, no se lo pisamos.
    const previo = await dalegas('GET', `/api/lote/${jobId}`, null, 60000).catch(() => null);
    if (previo && previo.ok && previo.data && previo.data.status && previo.data.status !== 'completado') {
      const creado = Date.parse(previo.data.created_at || '') || 0;
      if (Date.now() - creado < POLL_MAX_MS) return { salteado: 'hay una verificación de este período en curso' };
    }

    await dalegas('DELETE', `/api/lote/${jobId}`, null, 60000).catch(() => {});
    const alta = await dalegas('POST', '/api/lote', { nombre, patentes, force: false });
    if (!alta.ok || alta.data.error || !alta.data.job_id) {
      throw new Error(`dalegas no creó el job: ${alta.data.error || 'HTTP ' + alta.status}`);
    }
    const id = alta.data.job_id;

    const t0 = Date.now();
    let job;
    for (;;) {
      const r = await dalegas('GET', `/api/lote/${id}`, null, 60000);
      job = r.data || {};
      const res = job.resultados || [];
      const pendientes = res.filter(x => x.status === 'pendiente').length;
      if (job.status === 'completado' || (res.length && pendientes === 0)) break;
      if (Date.now() - t0 > POLL_MAX_MS) throw new Error(`el job no terminó en 3 h (${pendientes} pendientes)`);
      await new Promise(ok => setTimeout(ok, POLL_MS));
    }

    const config = leerConfig();
    const regMap = {};
    registros.forEach(r => { regMap[r.UDOMINIO] = r; });
    const detalle = (job.resultados || []).map(item => ({
      registro: regMap[item.patente] || { UDOMINIO: item.patente, UAPEYNOM: '-' },
      clasificacion: clasificarItemLote(item, config)
    }));
    const resumen = {};
    detalle.forEach(d => { resumen[d.clasificacion.codigo] = (resumen[d.clasificacion.codigo] || 0) + 1; });
    actualizarVerificacion(periodoId, { resumen, detalle, actualizadoEn: new Date().toISOString(), origen: 'auto' });
    return { total: detalle.length, resumen };
  }

  async function correr(ids, motivo) {
    if (corriendo) return { ok: false, error: 'ya hay una actualización automática corriendo' };
    corriendo = true;
    const salida = {};
    try {
      for (const id of ids) {
        try {
          const r = await correrPeriodo(id);
          estado.corridas[id] = { ok: true, en: new Date().toISOString(), ...r };
          console.log(`[verif-auto] ${id} (${motivo}):`, JSON.stringify(r.resumen || r));
          salida[id] = r;
        } catch (e) {
          estado.corridas[id] = { ok: false, en: new Date().toISOString(), msg: e.message };
          console.error(`[verif-auto] ${id} (${motivo}) FALLÓ:`, e.message);
          salida[id] = { error: e.message };
          notificar(`⚠️ Obleas: la actualización automática de *${nombreLegible(id)}* falló (${motivo}).\n${e.message}\nEl reporte quedó como estaba; se reintenta en el próximo horario.`);
        }
      }
    } finally {
      corriendo = false;
      guardarEstado(estado);
    }
    return { ok: true, resultados: salida };
  }

  // Revisa cada 5 min si toca un horario. Clave del slot = "YYYY-MM-DD HH:MM" (ART).
  function tick() {
    const ahora = ahoraART();
    const hoy = fechaART(ahora);
    const minAhora = ahora.getUTCHours() * 60 + ahora.getUTCMinutes();
    for (const h of HORARIOS) {
      const [hh, mm] = h.split(':').map(Number);
      const minSlot = hh * 60 + mm;
      const clave = `${hoy} ${h}`;
      if (minAhora < minSlot || minAhora > minSlot + MARGEN_SLOT_MIN) continue;
      if (estado.ultimoSlot && estado.ultimoSlot >= clave) continue;
      if (corriendo) return;
      estado.ultimoSlot = clave;
      guardarEstado(estado);
      const ids = periodosElegibles();
      if (ids.length) correr(ids, `horario ${h}`);
      return;
    }
  }

  function iniciar() {
    setTimeout(tick, 30 * 1000);
    setInterval(tick, 5 * 60 * 1000);
    console.log(`[verif-auto] activo: ${HORARIOS.join(' y ')} ART, hasta el día ${DIA_CIERRE} del mes siguiente`);
  }

  function info() {
    const periodos = listarPeriodos()
      .filter(p => fechaCierre(p.periodoId))
      .map(p => ({
        periodoId: p.periodoId,
        nombre: nombreLegible(p.periodoId),
        conVerificacion: !!(p.resumen && p.resumen.verificacion),
        seActualizaHasta: fechaCierre(p.periodoId),
        abierta: ventanaAbierta(p.periodoId),
        ultimaCorrida: estado.corridas[p.periodoId] || null
      }));
    return { horarios: HORARIOS, diaCierre: DIA_CIERRE, corriendo, ultimoSlot: estado.ultimoSlot || null, ultimoReporte: ultimoReporte(), periodos };
  }

  return { iniciar, correr, info, fechaCierre, ventanaAbierta };
}

module.exports = { crear, fechaCierre, ventanaAbierta, mesEmpezado, nombreLegible };
