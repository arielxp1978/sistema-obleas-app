/**
 * Vencidos sin renovar — la lista de clientes "perdidos".
 *
 * Qué es: vehículos de los períodos guardados cuya oblea lleva MÁS de DIAS_MIN días vencida
 * y todavía no renovó (se muestran hasta DIAS_MAX; pasada esa ventana quedan como archivo).
 * Es una lista para consultar y llamar, no un reporte mensual: cada día entran los que cumplen
 * 60 días y salen los que renuevan.
 *
 * Por qué consulta en vivo y no usa el resultado de la verificación: la verificación pasa por
 * dalegas, que resuelve casi todo desde enargas_data y no ve renovaciones en talleres que el
 * feed no trae (ES-46: ~3 a 7 % de falsos "No renovó"). Acá cada patente se confirma contra
 * la misma consulta de ENARGAS que usa lib/verificar.js.
 *
 * Archivos (volumen data/, no van a git — tienen datos personales):
 *   data/vencidos.json        → la lista, la reescribe la corrida nocturna
 *   data/vencidos-notas.json  → lo que escribe la gente (tipificación + detalle). Aparte a
 *                               propósito: la corrida nunca toca las notas.
 */
const fs = require('fs');
const path = require('path');
const { consultarPatente } = require('./verificar');
const { listarPeriodos, leerPeriodo } = require('./storage');

const DIAS_MIN = 60;                 // "más de 60 días vencida" = perdida
const DIAS_MAX = 120;                // hasta acá se la ve en la lista principal
const HORARIO = '08:30';             // ART. Después del import InfoSys de las 07:30 y de verif-auto de las 07:45
const MARGEN_SLOT_MIN = 180;
const CONCURRENCIA = 4;
const DATA_DIR = path.join(__dirname, '..', 'data');
const LISTA_PATH = path.join(DATA_DIR, 'vencidos.json');
const NOTAS_PATH = path.join(DATA_DIR, 'vencidos-notas.json');

const TIPIFICACIONES = [
  { codigo: 'vendio_auto', texto: 'Vendí el auto' },
  { codigo: 'baja_equipo', texto: 'Baja de equipo' },
  { codigo: 'sin_plata', texto: 'No tengo $' },
  { codigo: 'sin_tiempo', texto: 'No tengo tiempo' },
  { codigo: 'oblea_trucha', texto: 'Oblea trucha' }
];

// ── Fechas (hora Argentina, UTC-3 fijo) ──
function hoyART() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); }
function diasEntre(desdeIso, hastaIso) {
  return Math.round((Date.parse(hastaIso + 'T00:00:00Z') - Date.parse(desdeIso + 'T00:00:00Z')) / 86400000);
}
// "1/8/2026" → "2026-08-01"
function vtoIso(str) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(str || '').trim());
  if (!m) return null;
  return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}
const clave = (patente, vto) => `${patente}|${vto}`;

// ── Interpretar la respuesta de ENARGAS para una patente ──
// Devuelve { estado, ... } con estado: abierto | renovo | baja | sin_registro | error
function interpretar(resp, vto) {
  if (!resp) return { estado: 'error' };
  if (resp.error !== '0' && resp.error !== 0) {
    if (/sin registros/i.test(resp.mensaje || '')) return { estado: 'sin_registro' };
    return { estado: 'error', msg: resp.mensaje || String(resp.error) };
  }
  const d = resp.data;
  const op = d && d.datosOperacion;
  if (!op) return { estado: 'sin_registro' };
  const dia = (s) => (s ? String(s).slice(0, 10) : '');
  const info = {
    ultimaOp: op.operacion || '',
    ultimaOpFecha: dia(op.fechaHabilitacion),
    nuevoVto: dia(op.fechaVencimiento),
    pec: (d.datosPEC && d.datosPEC.razonSocial) || '',
    pecCodigo: (d.datosPEC && d.datosPEC.codigo) || '',
    taller: (d.datosTaller && d.datosTaller.razonSocial) || ''
  };
  if (/^baja/i.test(info.ultimaOp)) return { estado: 'baja', ...info };
  if (info.nuevoVto && info.nuevoVto > vto) return { estado: 'renovo', ...info };
  return { estado: 'abierto', ...info };
}

// ── Persistencia atómica ──
function leerJson(p, def) {
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.error('[vencidos] no se pudo leer', p, e.message); }
  return def;
}
function escribirJson(p, obj) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function crear({ leerConfig, notificar = () => {} }) {
  let corriendo = false;
  let ultimoSlot = (leerJson(LISTA_PATH, {}).ultimoSlot) || null;

  // Registros de los períodos guardados que hoy están en la ventana, ya descartando los que la
  // verificación guardada da por renovados (una renovación no se deshace).
  function candidatos(hoy) {
    const out = [];
    for (const p of listarPeriodos()) {
      if (!/^\d{1,2}-\d{4}$/.test(p.periodoId)) continue;
      const per = leerPeriodo(p.periodoId);
      if (!per) continue;
      const yaRenovo = new Set();
      ((per.verificacion && per.verificacion.detalle) || []).forEach(x => {
        const c = x.clasificacion || {};
        const cod = c.codigo;
        const renovado = cod === 'NUESTRO_PEC_NUESTRO_TALLER' || cod === 'NUESTRO_PEC_OTRO_TALLER' || cod === 'OTRO_PEC';
        if (renovado && x.registro) yaRenovo.add(String(x.registro.UDOMINIO || '').trim().toUpperCase());
      });
      for (const r of per.registros || []) {
        const patente = String(r.UDOMINIO || '').trim().toUpperCase();
        const vto = vtoIso(r.UFECVENHAB);
        if (!patente || !vto || yaRenovo.has(patente)) continue;
        const dias = diasEntre(vto, hoy);
        if (dias <= DIAS_MIN || dias > DIAS_MAX) continue;
        out.push({ patente, vto, periodoId: p.periodoId, registro: r });
      }
    }
    return out;
  }

  function fichaDe(c) {
    const r = c.registro;
    return {
      patente: c.patente, vto: c.vto, periodoId: c.periodoId,
      titular: (r.UAPEYNOM || '').trim(), telefono: (r.UTELEFONO_FINAL || '').trim(),
      whatsapp: (r.UTELEFONO_WHATSAPP || '').trim(), telEstado: r.UTELEFONO_ESTADO || '',
      localidad: r.ULOCALIDAD || '', vehiculo: `${r.UMARCA || ''} ${r.UMODELO || ''}`.trim(),
      anio: /^\d{4}$/.test(String(r.UANO)) ? parseInt(r.UANO) : null,
      vendedor: r.GNCOBS1 || ''
    };
  }

  async function actualizar(motivo = 'manual') {
    if (corriendo) return { ok: false, error: 'ya hay una actualización corriendo' };
    corriendo = true;
    try {
      const hoy = hoyART();
      const config = leerConfig();
      const estado = leerJson(LISTA_PATH, { items: {} });
      estado.items = estado.items || {};

      const lista = candidatos(hoy);
      // Un ítem ya guardado como renovado/baja no se vuelve a consultar; los abiertos sí (pueden renovar).
      const aConsultar = lista.filter(c => {
        const prev = estado.items[clave(c.patente, c.vto)];
        return !prev || prev.estado === 'abierto' || prev.estado === 'sin_registro';
      });
      // Los ya guardados que siguen abiertos pero salieron de la ventana por arriba (>120 d) quedan como archivo, sin consultar.

      let i = 0, errores = 0, nuevos = 0, renovaron = 0;
      async function worker() {
        while (i < aConsultar.length) {
          const c = aConsultar[i++];
          let resp = null, ok = false;
          for (let intento = 0; intento < 2 && !ok; intento++) {
            try { resp = await consultarPatente(c.patente, config); ok = true; } catch (e) { /* reintenta */ }
          }
          if (!ok) { errores++; continue; }
          const res = interpretar(resp, c.vto);
          if (res.estado === 'error') { errores++; continue; }
          const k = clave(c.patente, c.vto);
          const prev = estado.items[k];
          if (res.estado === 'renovo') {
            if (prev) { // estaba en la lista y renovó: queda marcado, ya no se consulta más
              estado.items[k] = { ...prev, estado: 'renovo', renovoEn: res.ultimaOpFecha, renovoTaller: res.taller, consultadoEn: new Date().toISOString() };
              renovaron++;
            }
            continue; // si nunca estuvo en la lista, no hace falta guardarlo
          }
          if (!prev) nuevos++;
          estado.items[k] = { ...fichaDe(c), ...(prev || {}), ...fichaDe(c), estado: res.estado,
            ultimaOp: res.ultimaOp, ultimaOpFecha: res.ultimaOpFecha, ultimaOpEn: res.pec, ultimaOpPec: res.pecCodigo,
            ultimaOpTaller: res.taller, consultadoEn: new Date().toISOString() };
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCIA }, worker));

      estado.actualizadoEn = new Date().toISOString();
      estado.ultimoSlot = ultimoSlot;
      estado.resumenCorrida = { motivo, consultadas: aConsultar.length, nuevos, renovaron, errores };
      escribirJson(LISTA_PATH, estado);
      console.log(`[vencidos] ${motivo}:`, JSON.stringify(estado.resumenCorrida));
      if (errores > aConsultar.length / 2 && aConsultar.length > 10) {
        notificar(`⚠️ Obleas: la lista "Vencidos sin renovar" tuvo ${errores} errores de consulta sobre ${aConsultar.length} (${motivo}). Quedó como estaba; se reintenta mañana.`);
      }
      return { ok: true, ...estado.resumenCorrida };
    } catch (e) {
      console.error('[vencidos] FALLÓ:', e.message);
      notificar(`⚠️ Obleas: falló la actualización de "Vencidos sin renovar" (${motivo}).\n${e.message}`);
      return { ok: false, error: e.message };
    } finally {
      corriendo = false;
    }
  }

  // Lo que ve la pantalla: items + notas mezcladas. El filtrado fino lo hace el navegador.
  function obtener() {
    const hoy = hoyART();
    const estado = leerJson(LISTA_PATH, { items: {} });
    const notas = leerJson(NOTAS_PATH, {});
    const items = Object.entries(estado.items || {}).map(([k, it]) => {
      const n = notas[k] || null;
      return { ...it, dias: diasEntre(it.vto, hoy), nota: n };
    }).sort((a, b) => a.vto.localeCompare(b.vto) || a.patente.localeCompare(b.patente));
    return {
      ok: true, hoy, diasMin: DIAS_MIN, diasMax: DIAS_MAX, tipificaciones: TIPIFICACIONES,
      actualizadoEn: estado.actualizadoEn || null, ultimaCorrida: estado.resumenCorrida || null,
      corriendo, horario: HORARIO, items
    };
  }

  function guardarNota({ patente, vto, tipificacion, detalle }, usuario) {
    patente = String(patente || '').trim().toUpperCase();
    const estado = leerJson(LISTA_PATH, { items: {} });
    const k = clave(patente, vto);
    if (!estado.items || !estado.items[k]) return { ok: false, status: 404, error: 'Esa patente no está en la lista' };
    tipificacion = String(tipificacion || '');
    if (tipificacion && !TIPIFICACIONES.some(t => t.codigo === tipificacion)) {
      return { ok: false, status: 400, error: 'Tipificación inválida' };
    }
    detalle = String(detalle || '').slice(0, 1000);
    const notas = leerJson(NOTAS_PATH, {});
    if (!tipificacion && !detalle) delete notas[k];
    else notas[k] = { tipificacion, detalle, usuario: usuario || '', en: new Date().toISOString() };
    escribirJson(NOTAS_PATH, notas);
    return { ok: true, nota: notas[k] || null };
  }

  // Una corrida por día a partir de HORARIO (ART); si el server estuvo caído, la recupera hasta 3 h tarde.
  // La primera vez (no hay lista todavía) arma la lista al arrancar.
  function tick() {
    const ahora = new Date(Date.now() - 3 * 3600 * 1000);
    const hoy = ahora.toISOString().slice(0, 10);
    const min = ahora.getUTCHours() * 60 + ahora.getUTCMinutes();
    const [hh, mm] = HORARIO.split(':').map(Number);
    const slot = hh * 60 + mm;
    const k = `${hoy} ${HORARIO}`;
    if (min < slot || min > slot + MARGEN_SLOT_MIN) return;
    if (ultimoSlot && ultimoSlot >= k) return;
    if (corriendo) return;
    ultimoSlot = k;
    actualizar(`horario ${HORARIO}`);
  }
  function iniciar() {
    if (!fs.existsSync(LISTA_PATH)) setTimeout(() => actualizar('primera carga'), 60 * 1000);
    setTimeout(tick, 45 * 1000);
    setInterval(tick, 5 * 60 * 1000);
    console.log(`[vencidos] activo: una corrida por día a las ${HORARIO} ART (vencidas entre ${DIAS_MIN + 1} y ${DIAS_MAX} días)`);
  }

  return { iniciar, actualizar, obtener, guardarNota, estaCorriendo: () => corriendo };
}

module.exports = { crear, interpretar, vtoIso, diasEntre, TIPIFICACIONES, DIAS_MIN, DIAS_MAX };
