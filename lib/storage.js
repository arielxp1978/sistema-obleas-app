/**
 * Almacenamiento persistente de períodos en archivos JSON
 * Estructura: data/periodos/{periodo}.json
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'periodos');

// Asegurar que exista el directorio
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function guardarPeriodo(periodoId, datos) {
  const filepath = path.join(DATA_DIR, `${periodoId}.json`);
  const payload = {
    ...datos,
    periodoId,
    guardadoEn: new Date().toISOString(),
    version: fs.existsSync(filepath) ? (leerPeriodo(periodoId)?.version || 0) + 1 : 1
  };
  fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function leerPeriodo(periodoId) {
  const filepath = path.join(DATA_DIR, `${periodoId}.json`);
  if (!fs.existsSync(filepath)) return null;
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function listarPeriodos() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        return {
          periodoId: data.periodoId,
          guardadoEn: data.guardadoEn,
          version: data.version || 1,
          resumen: {
            totalOriginal: data.totalOriginal || 0,
            totalFiltrado: data.totalFiltrado || 0,
            normalizacion: data.normalizacion || {},
            verificacion: data.verificacion?.resumen || null
          }
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.periodoId.localeCompare(a.periodoId));
}

function eliminarPeriodo(periodoId) {
  const filepath = path.join(DATA_DIR, `${periodoId}.json`);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
}

function generarHistorial() {
  const periodos = listarPeriodos();
  const detalle = periodos.map(p => leerPeriodo(p.periodoId)).filter(Boolean);

  const historial = {
    generadoEn: new Date().toISOString(),
    totalPeriodos: periodos.length,
    periodos: periodos,
    acumulado: {
      totalRegistrosOriginal: 0,
      totalRegistrosFiltrado: 0,
      normalizacion: { OK: 0, LEVE: 0, RECHAZAR: 0 },
      verificacion: { NUESTRO_PEC_NUESTRO_TALLER: 0, NUESTRO_PEC_OTRO_TALLER: 0, OTRO_PEC: 0, NO_RENOVO: 0 },
      porUsuario: {},
      evolucion: [] // para gráficos de tendencia
    }
  };

  detalle.forEach(p => {
    historial.acumulado.totalRegistrosOriginal += p.totalOriginal || 0;
    historial.acumulado.totalRegistrosFiltrado += p.totalFiltrado || 0;

    if (p.normalizacion) {
      Object.entries(p.normalizacion).forEach(([k, v]) => {
        historial.acumulado.normalizacion[k] = (historial.acumulado.normalizacion[k] || 0) + v;
      });
    }

    if (p.verificacion?.resumen) {
      Object.entries(p.verificacion.resumen).forEach(([k, v]) => {
        historial.acumulado.verificacion[k] = (historial.acumulado.verificacion[k] || 0) + v;
      });
    }

    // Por usuario
    if (p.metricasOriginal?.por_usuario) {
      Object.entries(p.metricasOriginal.por_usuario).forEach(([user, data]) => {
        if (!historial.acumulado.porUsuario[user]) {
          historial.acumulado.porUsuario[user] = { total: 0, sin: 0, mal: 0, ok: 0 };
        }
        historial.acumulado.porUsuario[user].total += data.total || 0;
        historial.acumulado.porUsuario[user].sin += data.sin || 0;
        historial.acumulado.porUsuario[user].mal += data.mal || 0;
        historial.acumulado.porUsuario[user].ok += data.ok || 0;
      });
    }

    // Evolución temporal
    historial.acumulado.evolucion.push({
      periodo: p.periodoId,
      original: p.totalOriginal || 0,
      filtrado: p.totalFiltrado || 0,
      normalizacion: p.normalizacion || {},
      verificacion: p.verificacion?.resumen || {}
    });
  });

  return historial;
}

module.exports = { guardarPeriodo, leerPeriodo, listarPeriodos, eliminarPeriodo, generarHistorial };
