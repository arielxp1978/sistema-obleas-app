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
function esComisionistaPropio(subtal) {
  const s = (subtal || '').trim();
  if (!s || !s.includes('@')) return true;   // sin comisionista = directo del taller = nuestro
  return COMISIONISTAS_PROPIOS.has(s);
}

function filtrar(rows) {
  return rows.filter(r => esTallerNuestro(r) && esComisionistaPropio(r.SUBTAL));
}

function procesarTelefonos(rows) {
  return rows.map((r, idx) => {
    const n = normalizarTel(r.UTELEFONO);
    return {
      ...r, _idx: idx,
      UTELEFONO_ORIGINAL: r.UTELEFONO,
      UTELEFONO: n.limpio,
      UTELEFONO_SUGERENCIA: n.limpio,
      UTELEFONO_FINAL: n.estado === 'OK' ? n.limpio : '',
      UTELEFONO_WHATSAPP: n.whatsapp,
      UTELEFONO_ESTADO: n.estado,
      UTELEFONO_ERROR: n.errorDesc,
      _errorTipo: n.errorTipo,
      _errorDesc: n.errorDesc
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
    const u = r.GNCOBS1 || 'DESCONOCIDO';
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

function dividirArchivos(rows) {
  const byPeriod = {};
  rows.forEach(r => {
    const f = r.UFECVENHAB || ''; let key = 'sin-fecha';
    const parts = f.split('/');
    if (parts.length === 3) { const [, mm, y] = parts.map(Number); key = `${mm}-${y}`; }
    if (!byPeriod[key]) byPeriod[key] = [];
    byPeriod[key].push(r);
  });
  const files = [];
  Object.entries(byPeriod).forEach(([period, regs]) => {
    for (let i = 0; i < regs.length; i += 50) {
      const chunk = regs.slice(i, i + 50);
      const v = Math.floor(i / 50) + 1;
      const name = `${period}-V${v}.csv`;
      const header = KEEP_COLS.join(';');
      const lines = chunk.map(r => {
        const row = { ...r };
        if (row.UTELEFONO_FINAL && row.UTELEFONO_FINAL.length === 10) {
          row.UTELEFONO = row.UTELEFONO_FINAL;
          row.UTELEFONO_WHATSAPP = '549' + row.UTELEFONO_FINAL;
          row.UTELEFONO_ESTADO = 'OK';
        }
        return KEEP_COLS.map(c => row[c] || '').join(';');
      });
      const estados = {};
      chunk.forEach(r => {
        let st = r.UTELEFONO_ESTADO;
        if (r.UTELEFONO_FINAL && r.UTELEFONO_FINAL.length === 10) st = 'OK';
        estados[st] = (estados[st] || 0) + 1;
      });
      files.push({ name, records: chunk.length, period, version: v, content: header + '\n' + lines.join('\n'), estados });
    }
  });
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
  const externos = opts.yaFiltrado ? [] : rows.filter(r => esTallerNuestro(r) && !esComisionistaPropio(r.SUBTAL));
  const excluidosComisionista = {
    total: externos.length,
    porComisionista: externos.reduce((a, r) => {
      const k = (r.SUBTAL || '').trim() || '(sin)';
      a[k] = (a[k] || 0) + 1; return a;
    }, {})
  };

  const archivos = dividirArchivos(normalizados);

  // Detect period
  let periodo = 'sin-fecha';
  if (archivos.length) periodo = archivos[0].period;

  return {
    periodo,
    totalOriginal: rows.length,
    totalFiltrado: normalizados.length,
    metricasOriginal,
    metricasFiltrado,
    normalizados,
    archivos,
    normalizacion: normStats,
    excluidosComisionista
  };
}

function procesarCompleto(csvText) {
  return procesarRows(parseCSV(csvText));
}

module.exports = { parseCSV, filtrar, esTallerNuestro, esComisionistaPropio, COMISIONISTAS_PROPIOS, procesarTelefonos, generarMetricas, dividirArchivos, procesarCompleto, procesarRows, normalizarLocalidad, KEEP_COLS };
