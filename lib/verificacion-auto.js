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

// ── KPI central (obleas público): foto diaria para ver la evolución durante la campaña ──
// Una foto por día (ART), solo mientras la ventana está abierta: después del cierre el KPI queda
// fijo en la última foto. Se guarda por grupo de envío ('' = todos) para que el filtro de la
// pantalla también tenga evolución. nt = Nuestro PEC + Nuestro Taller; red = nt + Nuestro PEC + Taller Externo.
function kpiDesdeDetalle(detalle) {
  const g = {};
  const sumar = (k, cod) => {
    const x = g[k] || (g[k] = { total: 0, nt: 0, red: 0 });
    x.total++;
    if (cod === 'NUESTRO_PEC_NUESTRO_TALLER') { x.nt++; x.red++; }
    else if (cod === 'NUESTRO_PEC_OTRO_TALLER') x.red++;
  };
  (detalle || []).forEach(d => {
    const cod = d.clasificacion && d.clasificacion.codigo;
    sumar('', cod);
    sumar((d.registro && d.registro._tipoVencimiento) || 'ph_desconocido', cod);
  });
  return g;
}
function registrarKpi(periodoId, verificacion, evolucionPrevia) {
  const evol = Array.isArray(evolucionPrevia) ? evolucionPrevia.slice() : [];
  if (!verificacion || !Array.isArray(verificacion.detalle) || !verificacion.detalle.length) return evol;
  if (!ventanaAbierta(periodoId)) return evol;   // cerrado (o mes futuro): no se mueve más
  const fecha = fechaART(ahoraART());
  const foto = { fecha, en: new Date().toISOString(), grupos: kpiDesdeDetalle(verificacion.detalle) };
  const i = evol.findIndex(x => x.fecha === fecha);
  if (i >= 0) evol[i] = foto; else evol.push(foto);
  return evol.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

// Resumen de un período para la historia del año. Si el período está cerrado, cuenta solo las
// renovaciones con fechaOp <= día de cierre (= el número que quedó fijo ese día); si está en curso,
// todo lo que hay hoy. Por grupo de envío ('' = todos). no = no renovó (al cierre) + bajas/errores.
function kpiMes(periodo) {
  if (!periodo || !periodo.verificacion || !Array.isArray(periodo.verificacion.detalle) || !periodo.verificacion.detalle.length) return null;
  const m = /^(\d{1,2})-(\d{4})$/.exec(periodo.periodoId || '');
  if (!m) return null;
  const cierre = fechaCierre(periodo.periodoId);
  const cerrado = fechaART(ahoraART()) > cierre;
  const g = {};
  let sinTaller = 0;   // nuestro PEC sin taller informado (hueco de datos de dalegas, ES-45)
  let dudosos = 0;     // ERROR_TECNICO / PROCESANDO / PENDIENTE: datos con duda. Hoy cuentan dentro de 'no'; acá se ven aparte.
  const sumar = (k, campo) => { const x = g[k] || (g[k] = { total: 0, nt: 0, ext: 0, otro: 0, no: 0 }); x.total++; x[campo]++; };
  periodo.verificacion.detalle.forEach(d => {
    const c = d.clasificacion || {};
    const f = String(c.fechaOp || '').slice(0, 10);
    const aTiempo = !cerrado || !/^\d{4}-\d{2}-\d{2}$/.test(f) || f <= cierre;
    let campo = 'no';
    if (aTiempo && c.codigo === 'NUESTRO_PEC_NUESTRO_TALLER') campo = 'nt';
    else if (aTiempo && c.codigo === 'NUESTRO_PEC_OTRO_TALLER') campo = 'ext';
    else if (aTiempo && c.codigo === 'OTRO_PEC') campo = 'otro';
    if (campo === 'ext' && !c.tallerCodigo) sinTaller++;
    if (c.codigo === 'ERROR_TECNICO' || c.codigo === 'PROCESANDO' || c.codigo === 'PENDIENTE') dudosos++;
    sumar('', campo);
    sumar((d.registro && d.registro._tipoVencimiento) || 'ph_desconocido', campo);
  });
  return { periodoId: periodo.periodoId, mes: parseInt(m[1]), anio: parseInt(m[2]), cierre, cerrado, sinTaller, dudosos, grupos: g };
}

// La API manda created_at sin zona horaria ("2026-10-13T10:45:59.036326"), pero es UTC
// (coincide con los timestamps en Z que guarda esta app). Sin esto Date.parse la tomaría como hora local.
function fechaApiMs(s) {
  if (!s) return 0;
  const t = String(s);
  return Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(t) ? t : t + 'Z') || 0;
}

// OB-13: qué hacer con el job que dalegas ya tiene para este período.
//   nuevo     → no hay job: se pide uno.
//   usar      → está terminado y es MÁS NUEVO que lo último guardado: nadie leyó ese resultado
//               (ej. el POST expiró pero la API siguió trabajando). Se clasifica sin volver a pedir.
//               ⚠️ Si fuera MÁS VIEJO que lo guardado, reusarlo congelaría el reporte: el id del job
//               es siempre el mismo, así que "completado" solo no alcanza para reusarlo.
//   saltear   → sigue avanzando (los pendientes bajan) o recién lo vemos: no se toca.
//   reencolar → ya consumido, o lleva más de 3 h con los mismos pendientes: se borra y se pide de nuevo.
// `visto` = { pendientes, desde } de la última vez que lo miramos; devuelve el `visto` nuevo.
function decidirJobPrevio({ previo, ultimaGuardadaMs, visto, ahoraMs }) {
  if (!previo || !previo.ok || !previo.data || !previo.data.status) return { accion: 'nuevo' };
  const res = previo.data.resultados || [];
  const pend = res.filter(x => x.status === 'pendiente').length;
  const terminado = previo.data.status === 'completado' || (res.length > 0 && pend === 0);
  if (terminado) {
    return fechaApiMs(previo.data.created_at) > ultimaGuardadaMs
      ? { accion: 'usar', pendientes: pend }
      : { accion: 'reencolar', motivo: 'terminado y ya consumido', pendientes: pend };
  }
  if (!visto || visto.pendientes !== pend) return { accion: 'saltear', pendientes: pend, visto: { pendientes: pend, desde: ahoraMs } };
  if (ahoraMs - visto.desde < POLL_MAX_MS) return { accion: 'saltear', pendientes: pend, visto };
  return { accion: 'reencolar', motivo: `sin avance hace más de 3 h (${pend} pendientes)`, pendientes: pend };
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

    // OB-13: mirar el job que ya existe ANTES de borrar nada.
    const previo = await dalegas('GET', `/api/lote/${jobId}`, null, 60000).catch(() => null);
    const ultimaGuardadaMs = Math.max(
      Date.parse((periodo.verificacion && periodo.verificacion.actualizadoEn) || '') || 0,
      Date.parse(periodo.guardadoEn || '') || 0);
    estado.vistos = estado.vistos || {};
    const dec = decidirJobPrevio({ previo, ultimaGuardadaMs, visto: estado.vistos[periodoId], ahoraMs: Date.now() });
    if (dec.visto) { estado.vistos[periodoId] = dec.visto; guardarEstado(estado); }

    if (dec.accion === 'saltear') return { salteado: `hay una verificación de este período en curso (${dec.pendientes} pendientes)` };

    let job;
    if (dec.accion === 'usar') {
      console.log(`[verif-auto] ${periodoId}: uso el job que quedó terminado sin leer (no se vuelve a pedir)`);
      job = previo.data;
    } else {
      if (dec.accion === 'reencolar') {
        console.log(`[verif-auto] ${periodoId}: reencolo (${dec.motivo})`);
        await dalegas('DELETE', `/api/lote/${jobId}`, null, 60000).catch(() => {});
      }
      delete estado.vistos[periodoId];
      const t0Post = Date.now();
      let id;
      try {
        const alta = await dalegas('POST', '/api/lote', { nombre, patentes, force: false }, 300000);
        if (!alta.ok || alta.data.error || !alta.data.job_id) {
          throw new Error(`dalegas no creó el job: ${alta.data.error || 'HTTP ' + alta.status}`);
        }
        id = alta.data.job_id;
      } catch (e) {
        // Si el POST expiró, la API igual creó el job y lo está trabajando: se sigue sobre ese job
        // en vez de darlo por fallido (si se diera por fallido, el próximo horario lo borraría y reencolaría).
        if (!/aborted|timeout|timed out/i.test(String(e && (e.name + ' ' + e.message)))) throw e;
        const creado = await dalegas('GET', `/api/lote/${jobId}`, null, 60000).catch(() => null);
        if (!creado || !creado.ok || fechaApiMs(creado.data && creado.data.created_at) < t0Post - 60000) throw e;
        console.log(`[verif-auto] ${periodoId}: el POST expiró pero el job existe; sigo sobre ese job`);
        id = jobId;
      }

      const t0 = Date.now();
      for (;;) {
        const r = await dalegas('GET', `/api/lote/${id}`, null, 60000);
        job = r.data || {};
        const res = job.resultados || [];
        const pendientes = res.filter(x => x.status === 'pendiente').length;
        if (job.status === 'completado' || (res.length && pendientes === 0)) break;
        if (Date.now() - t0 > POLL_MAX_MS) {
          // No se tira lo resuelto: se guarda lo que hay, marcado como parcial (ver más abajo).
          console.warn(`[verif-auto] ${periodoId}: el job no terminó en 3 h (${pendientes} pendientes); guardo lo resuelto`);
          break;
        }
        await new Promise(ok => setTimeout(ok, POLL_MS));
      }
    }

    const config = leerConfig();
    const regMap = {};
    registros.forEach(r => { regMap[r.UDOMINIO] = r; });
    const detalle = (job.resultados || []).map(item => ({
      registro: regMap[item.patente] || { UDOMINIO: item.patente, UAPEYNOM: '-' },
      clasificacion: clasificarItemLote(item, config)
    }));
    // Parcial: lo que sigue pendiente NO pisa un resultado ya conocido del reporte anterior.
    const pendientesAlCortar = detalle.filter(d => d.clasificacion.codigo === 'PENDIENTE').length;   // antes de conservar lo anterior
    const parcial = pendientesAlCortar > 0;
    if (parcial && periodo.verificacion && Array.isArray(periodo.verificacion.detalle)) {
      const anterior = {};
      periodo.verificacion.detalle.forEach(d => { if (d.registro) anterior[d.registro.UDOMINIO] = d; });
      detalle.forEach((d, i) => {
        const prev = anterior[d.registro.UDOMINIO];
        if (d.clasificacion.codigo === 'PENDIENTE' && prev && prev.clasificacion && prev.clasificacion.codigo !== 'PENDIENTE') detalle[i] = prev;
      });
    }
    const resumen = {};
    detalle.forEach(d => { resumen[d.clasificacion.codigo] = (resumen[d.clasificacion.codigo] || 0) + 1; });
    const verificacion = { resumen, detalle, actualizadoEn: new Date().toISOString(), origen: 'auto' };
    if (parcial) verificacion.parcial = { pendientes: pendientesAlCortar, sinResolver: detalle.filter(d => d.clasificacion.codigo === 'PENDIENTE').length };
    // La foto diaria del KPI no se mueve con un resultado parcial: distorsionaría el total del día.
    actualizarVerificacion(periodoId, verificacion, { kpiEvolucion: parcial ? (periodo.kpiEvolucion || []) : registrarKpi(periodoId, verificacion, periodo.kpiEvolucion) });
    return { total: detalle.length, resumen, ...(parcial ? { parcial: verificacion.parcial.pendientes } : {}) };
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
          if (r && r.parcial) notificar(`⚠️ Obleas: *${nombreLegible(id)}* se guardó PARCIAL: ${r.parcial} patentes siguen pendientes en ENARGAS. Lo ya resuelto se conservó; se completa en el próximo horario.`);
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

module.exports = { crear, decidirJobPrevio, fechaApiMs, fechaCierre, ventanaAbierta, mesEmpezado, nombreLegible, registrarKpi, kpiMes };
