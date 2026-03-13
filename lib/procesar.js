/**
 * Pipeline de procesamiento de CSVs de obleas GNC
 */
const { normalizarTel, analizarTelError } = require('./normalizar');

const KEEP_COLS = [
  "UFECVENHAB", "UDOMINIO", "UMARCA", "UMODELO", "UANO", "UAPEYNOM",
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
    return obj;
  });
}

function filtrar(rows) {
  return rows.filter(r => {
    const t = (r.TCODTAL || '').trim(), g = (r.GNCOBS3 || '').trim();
    return (t === 'IRT0550' && g === '') || t === 'HIT0797' || t === 'QUT0865';
  });
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

function procesarCompleto(csvText) {
  const rows = parseCSV(csvText);
  const metricasOriginal = generarMetricas(rows, 'ORIGINAL');
  const filtrados = filtrar(rows);
  const normalizados = procesarTelefonos(filtrados);
  const metricasFiltrado = generarMetricas(normalizados, 'FILTRADO');

  const normStats = { OK: 0, LEVE: 0, RECHAZAR: 0 };
  normalizados.forEach(r => normStats[r.UTELEFONO_ESTADO] = (normStats[r.UTELEFONO_ESTADO] || 0) + 1);
  metricasFiltrado.normalizacion = normStats;

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
    normalizacion: normStats
  };
}

module.exports = { parseCSV, filtrar, procesarTelefonos, generarMetricas, dividirArchivos, procesarCompleto, KEEP_COLS };
