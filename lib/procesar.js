/**
 * Pipeline de procesamiento de CSVs de obleas GNC
 */
const { normalizarTel, analizarTelError } = require('./normalizar');

const KEEP_COLS = [
  "UFECVENHAB", "UDOMINIO", "UOBLEANEW", "UMARCA", "UMODELO", "UANO", "UAPEYNOM",
  "UCALLEYNRO", "ULOCALIDAD", "UPROVINCIA", "UCODPOSTAL", "UTELEFONO",
  "UTELEFONO_ORIGINAL", "UTELEFONO_WHATSAPP", "UTELEFONO_ESTADO", "UTELEFONO_ERROR",
  "UTIPDOC", "UNRODOC", "GNCOBS3", "TCODTAL", "GNCOBS1"
];

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ';') { fields.push(current.trim()); current = ''; }
      else { current += ch; }
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, j) => obj[h.trim()] = (vals[j] || '').trim());
    // Normalizar localidades y provincias (quitar tildes, unificar mayúsculas)
    if (obj.ULOCALIDAD) obj.ULOCALIDAD = normalizarLocalidad(obj.ULOCALIDAD);
    if (obj.UPROVINCIA) obj.UPROVINCIA = normalizarLocalidad(obj.UPROVINCIA);
    return obj;
  });
}

// Normaliza localidades: quita tildes en vocales, conserva Ñ
// CÓRDOBA → CORDOBA, MALAGÜEÑO → MALAGÜEÑO, etc.
const LOCALIDAD_DISPLAY_MAP = {
  'MALAGUENO': 'MALAGÜEÑO',
  'MALAGU\u00d1O': 'MALAGÜEÑO',  // variante sin ü
};
function normalizarLocalidad(str) {
  if (!str) return '';
  let s = str.toUpperCase().trim()
    .replace(/[\u00C1\u00C0\u00C4\u00C2]/g, 'A')  // Á À Ä Â → A
    .replace(/[\u00C9\u00C8\u00CB\u00CA]/g, 'E')  // É È Ë Ê → E
    .replace(/[\u00CD\u00CC\u00CF\u00CE]/g, 'I')  // Í Ì Ï Î → I
    .replace(/[\u00D3\u00D2\u00D6\u00D4]/g, 'O')  // Ó Ò Ö Ô → O
    .replace(/[\u00DA\u00D9\u00DC\u00DB]/g, 'U'); // Ú Ù Ü Û → U
    // Ñ (\u00D1) NO se reemplaza — es una letra propia del español
  return LOCALIDAD_DISPLAY_MAP[s] || s;
}

// Talleres propios Nova (lista fija, confirmada con Ariel 2026-07-17 sobre los exports
// reales Sorvicor-202507 + Gp5-202507). Los exports reales usan QUT0867 (no QUT0856/0865,
// que solo aparecían en un archivo concatenado mal armado).
const TALLERES_PROPIOS = new Set(['IRT0550', 'HIT0797', 'QUT0867']);
function esTallerNuestro(r) {
  return TALLERES_PROPIOS.has((r.TCODTAL || '').trim());
}

// Comisionistas propios Nova (canales internos), lista fija. SUBTAL = `<taller>@<codigo>`.
// Cualquier SUBTAL con `@` que NO esté acá = taller externo operando con nuestro PEC → excluir.
// CLAVE: un mismo taller nuestro (ej. IRT0550) también hace obleas de comisionistas externos,
// por eso NO alcanza el taller: hace falta que el comisionista TAMBIÉN sea nuestro (filtrar = AND).
// SUBTAL vacío / sin `@` = trabajo directo del taller = nuestro.
const COMISIONISTAS_PROPIOS = new Set([
  '550@5', '550@6', '550@15',            // PROMOTP (Sorvicor)
  '797@2', '797@3', '797@4', '797@5',    // canales internos Nova R20 (HIT0797)
  '856@2', '856@4', '856@11'             // Agencia / Mostrador / PROMO TP (Grupo P5)
]);
// El código de comisionista vive en GNCOBS3 (reporte "vencimientos usuarios", 66 columnas —
// el formato con el que se construyó la app) o en SUBTAL (otro export de 144 columnas). Se toma
// el que exista, así el filtro funciona con ambos.
function getComisionista(r) {
  return (r.GNCOBS3 || r.SUBTAL || '').trim();
}
function esComisionistaPropio(cod) {
  const s = (cod || '').trim();
  if (!s || !s.includes('@')) return true;   // sin comisionista = directo del taller = nuestro
  return COMISIONISTAS_PROPIOS.has(s);
}

// Nombre legible de cada canal interno (para las métricas por comisionista).
const CANAL_NOMBRES = {
  '550@5': 'PROMOTP', '550@6': 'PROMOTP', '550@15': 'PROMOTP',
  '797@2': 'Nova R20 interno', '797@3': 'Nova R20 interno', '797@4': 'Nova R20 interno', '797@5': 'Nova R20 interno',
  '856@2': 'Agencia', '856@4': 'Mostrador', '856@11': 'PROMO TP'
};
function canalLabel(subtal) {
  const s = (subtal || '').trim();
  if (!s) return 'Directo (taller)';
  return CANAL_NOMBRES[s] ? `${s} · ${CANAL_NOMBRES[s]}` : `${s} · externo`;
}

function filtrar(rows) {
  return rows.filter(r => esTallerNuestro(r) && esComisionistaPropio(getComisionista(r)));
}

function procesarTelefonos(rows) {
  return rows.map((r, idx) => {
    const n = normalizarTel(r.UTELEFONO);
    return {
      ...r, _idx: idx,
      UTELEFONO_ORIGINAL: r.UTELEFONO,
      UTELEFONO: n.limpio,
      // Opción A: solo se sugiere un número cuando es válido con certeza (OK). Si no se puede
      // arreglar sin adivinar (LEVE/RECHAZAR), la sugerencia queda vacía y Yhonny lo completa a mano.
      UTELEFONO_SUGERENCIA: n.estado === 'OK' ? n.limpio : '',
      UTELEFONO_FINAL: n.estado === 'OK' ? n.limpio : '',
      UTELEFONO_WHATSAPP: n.whatsapp,
      UTELEFONO_ESTADO: n.estado,
      UTELEFONO_ERROR: n.errorDesc,
      _errorTipo: n.errorTipo,
      _errorDesc: n.errorDesc,
      _tipoGestion: tipoGestion(r)
    };
  });
}

function generarMetricas(rows, titulo) {
  const m = { titulo, total: rows.length, por_tcodtal: {}, telefonos: { total: rows.length, sin: 0, mal: 0, ok: 0, detalle: {} }, por_usuario: {} };
  const users = {};
  rows.forEach(r => {
    const t = r.TCODTAL || ''; m.por_tcodtal[t] = (m.por_tcodtal[t] || 0) + 1;
    const err = analizarTelError(r.UTELEFONO_ORIGINAL || r.UTELEFONO);
    m.telefonos.detalle[err] = (m.telefonos.detalle[err] || 0) + 1;
    if (err === 'SIN_TELEFONO') m.telefonos.sin++;
    else if (err === 'POSIBLE_OK') m.telefonos.ok++;
    else m.telefonos.mal++;
    // Agrupación por VENDEDOR (GNCOBS1 en el reporte "vencimientos usuarios": FLUNA, VDIAZ…).
    const u = r.GNCOBS1 || 'Sin vendedor';
    if (!users[u]) users[u] = { total: 0, sin: 0, mal: 0, ok: 0, errores: {}, tcodtal: {} };
    users[u].total++;
    users[u].errores[err] = (users[u].errores[err] || 0) + 1;
    users[u].tcodtal[t] = (users[u].tcodtal[t] || 0) + 1;
    if (err === 'SIN_TELEFONO') users[u].sin++;
    else if (err === 'POSIBLE_OK') users[u].ok++;
    else users[u].mal++;
  });
  Object.keys(users).forEach(u => {
    users[u].pct_err = Math.round((users[u].sin + users[u].mal) / Math.max(users[u].total, 1) * 100 * 10) / 10;
  });
  m.por_usuario = Object.fromEntries(Object.entries(users).sort((a, b) => b[1].pct_err - a[1].pct_err));
  return m;
}

// Tipo de gestión: UCODGEST 'X' = PH (Revisión CRPC); el resto = oblea (habilitación/rev. anual).
function tipoGestion(r) {
  return (r.UCODGEST || '').toString().trim().toUpperCase() === 'X' ? 'ph' : 'oblea';
}

// Teléfono WhatsApp válido (549 + 10 díg) o null. Prioriza la corrección manual del operador
// (UTELEFONO_FINAL) sobre la normalización automática. Solo los válidos se exportan a ManyChat.
function telWhatsappValido(r) {
  const fin = (r.UTELEFONO_FINAL || '').toString();
  if (fin.length === 10) return '549' + fin;
  if (r.UTELEFONO_ESTADO === 'OK' && r.UTELEFONO_WHATSAPP) return r.UTELEFONO_WHATSAPP;
  return null;
}

function periodoKey(fecha) {
  const parts = (fecha || '').split('/');
  if (parts.length === 3) { const [, mm, y] = parts.map(Number); return `${mm}-${y}`; }
  return 'sin-fecha';
}

// Columnas del export limpio para ManyChat (confirmado con Ariel 2026-07-17).
const EXPORT_COLS = [
  { header: 'nombre',   campo: 'UAPEYNOM' },
  { header: 'marca',    campo: 'UMARCA' },
  { header: 'modelo',   campo: 'UMODELO' },
  { header: 'patente',  campo: 'UDOMINIO' },
  { header: 'telefono', campo: '__wa' }     // se completa con telWhatsappValido
];

// Genera los archivos limpios para ManyChat, separados por TIPO (obleas / PH) y por período de
// vencimiento, con N teléfonos VÁLIDOS por archivo (opts.porArchivo, default 50). Solo entran
// registros con teléfono OK (o corregido a mano); los "0"/"11111"/basura no se exportan.
function dividirArchivos(rows, opts = {}) {
  const porArchivo = Math.max(1, parseInt(opts.porArchivo) || 50);
  const filaDe = (r, wa) => EXPORT_COLS.map(c => {
    const val = c.campo === '__wa' ? wa : (r[c.campo] || '');
    return String(val).replace(/[;\n\r]+/g, ' ').trim();
  });
  const header = EXPORT_COLS.map(c => c.header).join(';');
  const files = [];
  for (const tipo of ['oblea', 'ph']) {
    const prefijo = tipo === 'ph' ? 'ph' : 'obleas';
    const validos = rows
      .filter(r => tipoGestion(r) === tipo)
      .map(r => ({ r, wa: telWhatsappValido(r) }))
      .filter(x => x.wa);
    const byPeriod = {};
    validos.forEach(x => {
      const key = periodoKey(x.r.UFECVENHAB);
      (byPeriod[key] = byPeriod[key] || []).push(x);
    });
    Object.entries(byPeriod).forEach(([period, items]) => {
      for (let i = 0; i < items.length; i += porArchivo) {
        const chunk = items.slice(i, i + porArchivo);
        const v = Math.floor(i / porArchivo) + 1;
        const lines = chunk.map(x => filaDe(x.r, x.wa));
        files.push({
          name: `${prefijo}-${period}-V${v}.csv`,
          tipo, records: chunk.length, period, version: v,
          content: header + '\n' + lines.join('\n'),
          preview: chunk.slice(0, 5).map(x => filaDe(x.r, x.wa))
        });
      }
    });
  }
  return files;
}

// Procesa filas YA parseadas (objetos con campos U*). Núcleo compartido entre
// la importación por CSV (parseCSV) y la importación desde la base (nova_operaciones).
// opts.yaFiltrado = true → las filas ya están acotadas a talleres Nova, no re-filtrar.
function procesarRows(rows, opts = {}) {
  const metricasOriginal = generarMetricas(rows, 'ORIGINAL');
  const filtrados = opts.yaFiltrado ? rows : filtrar(rows);
  const normalizados = procesarTelefonos(filtrados);
  const metricasFiltrado = generarMetricas(normalizados, 'FILTRADO');

  const normStats = { OK: 0, LEVE: 0, RECHAZAR: 0 };
  normalizados.forEach(r => normStats[r.UTELEFONO_ESTADO] = (normStats[r.UTELEFONO_ESTADO] || 0) + 1);
  metricasFiltrado.normalizacion = normStats;

  // Visibilidad del filtro de comisionistas: obleas de taller nuestro pero comisionista
  // EXTERNO (excluidas del broadcast). Se muestra el desglose por SUBTAL para poder cazar
  // un código nuestro que quedó afuera del allowlist por error.
  const externos = opts.yaFiltrado ? [] : rows.filter(r => esTallerNuestro(r) && !esComisionistaPropio(getComisionista(r)));
  const excluidosComisionista = {
    total: externos.length,
    porComisionista: externos.reduce((a, r) => {
      const k = getComisionista(r) || '(sin)';
      a[k] = (a[k] || 0) + 1; return a;
    }, {})
  };

  const archivos = dividirArchivos(normalizados, { porArchivo: opts.porArchivo });

  // Detect period (el más común entre los registros normalizados, no depende de que haya archivos)
  const periodos = {};
  normalizados.forEach(r => { const k = periodoKey(r.UFECVENHAB); periodos[k] = (periodos[k] || 0) + 1; });
  let periodo = 'sin-fecha';
  const ordenados = Object.entries(periodos).filter(([k]) => k !== 'sin-fecha').sort((a, b) => b[1] - a[1]);
  if (ordenados.length) periodo = ordenados[0][0];

  // Resumen obleas vs PH y teléfonos válidos (para la UI)
  const resumenTipo = { oblea: { total: 0, conTel: 0 }, ph: { total: 0, conTel: 0 } };
  normalizados.forEach(r => {
    const t = tipoGestion(r);
    resumenTipo[t].total++;
    if (telWhatsappValido(r)) resumenTipo[t].conTel++;
  });

  return {
    periodo,
    totalOriginal: rows.length,
    totalFiltrado: normalizados.length,
    metricasOriginal,
    metricasFiltrado,
    normalizados,
    archivos,
    normalizacion: normStats,
    excluidosComisionista,
    resumenTipo
  };
}

function procesarCompleto(csvText) {
  return procesarRows(parseCSV(csvText));
}

module.exports = { parseCSV, filtrar, esTallerNuestro, esComisionistaPropio, COMISIONISTAS_PROPIOS, canalLabel, tipoGestion, telWhatsappValido, procesarTelefonos, generarMetricas, dividirArchivos, procesarCompleto, procesarRows, normalizarLocalidad, KEEP_COLS };
