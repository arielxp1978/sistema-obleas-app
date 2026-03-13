const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { procesarCompleto } = require('./lib/procesar');
const { clasificarPatente, consultarPatente } = require('./lib/verificar');
const { guardarPeriodo, leerPeriodo, listarPeriodos, eliminarPeriodo, generarHistorial } = require('./lib/storage');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;

// Clave de acceso: se toma de variable de entorno o default
const APP_CLAVE = process.env.APP_CLAVE || 'nova2026';

// Sesiones en memoria (token → timestamp)
const sessions = {};
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 horas

function generarToken() {
  return crypto.randomBytes(32).toString('hex');
}

function limpiarSesiones() {
  const now = Date.now();
  Object.keys(sessions).forEach(t => { if (now - sessions[t] > SESSION_DURATION) delete sessions[t]; });
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ============================================================
// AUTH
// ============================================================

// Login endpoint (público)
app.post('/api/login', (req, res) => {
  const { clave } = req.body;
  if (clave === APP_CLAVE) {
    limpiarSesiones();
    const token = generarToken();
    sessions[token] = Date.now();
    res.json({ ok: true, token });
  } else {
    res.status(401).json({ ok: false, error: 'Clave incorrecta' });
  }
});

// Servir login.html sin auth
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Middleware de autenticación
function authMiddleware(req, res, next) {
  // Verificar cookie o header
  const token = extraerToken(req);
  if (token && sessions[token] && (Date.now() - sessions[token] < SESSION_DURATION)) {
    sessions[token] = Date.now(); // renovar
    return next();
  }
  // Si es API, responder 401
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'No autenticado', redirect: '/login' });
  }
  // Si es página, redirigir al login
  return res.redirect('/login');
}

function extraerToken(req) {
  // 1. Header Authorization: Bearer <token>
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  // 2. Cookie: token=xxx
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/token=([a-f0-9]{64})/);
  if (match) return match[1];
  return null;
}

// Todo lo que no sea login requiere auth
app.use(authMiddleware);

// Archivos estáticos (protegidos)
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// PROCESAMIENTO
// ============================================================

// Subir y procesar CSV
app.post('/api/procesar', upload.single('archivo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se envió archivo' });
    const text = req.file.buffer.toString('utf8');
    const resultado = procesarCompleto(text);
    res.json({
      ok: true,
      periodo: resultado.periodo,
      totalOriginal: resultado.totalOriginal,
      totalFiltrado: resultado.totalFiltrado,
      metricasOriginal: resultado.metricasOriginal,
      metricasFiltrado: resultado.metricasFiltrado,
      normalizacion: resultado.normalizacion,
      archivos: resultado.archivos.map(a => ({ name: a.name, records: a.records, period: a.period, version: a.version, estados: a.estados })),
      registros: resultado.normalizados.map(r => ({
        _idx: r._idx,
        UDOMINIO: r.UDOMINIO, UAPEYNOM: r.UAPEYNOM, ULOCALIDAD: r.ULOCALIDAD,
        UPROVINCIA: r.UPROVINCIA, GNCOBS1: r.GNCOBS1, TCODTAL: r.TCODTAL,
        UFECVENHAB: r.UFECVENHAB, UTELEFONO_ORIGINAL: r.UTELEFONO_ORIGINAL,
        UTELEFONO_SUGERENCIA: r.UTELEFONO_SUGERENCIA, UTELEFONO_FINAL: r.UTELEFONO_FINAL,
        UTELEFONO_WHATSAPP: r.UTELEFONO_WHATSAPP, UTELEFONO_ESTADO: r.UTELEFONO_ESTADO,
        _errorTipo: r._errorTipo, _errorDesc: r._errorDesc,
        UMARCA: r.UMARCA, UMODELO: r.UMODELO, UANO: r.UANO,
        UCALLEYNRO: r.UCALLEYNRO, UCODPOSTAL: r.UCODPOSTAL,
        UTIPDOC: r.UTIPDOC, UNRODOC: r.UNRODOC, GNCOBS3: r.GNCOBS3,
        UTELEFONO: r.UTELEFONO, UTELEFONO_ERROR: r.UTELEFONO_ERROR
      }))
    });
  } catch (e) {
    console.error('Error procesando:', e);
    res.status(500).json({ error: e.message });
  }
});

// Generar archivos CSV (con ediciones del operador)
app.post('/api/generar-archivos', (req, res) => {
  try {
    const { registros } = req.body;
    const { dividirArchivos } = require('./lib/procesar');
    const archivos = dividirArchivos(registros);
    res.json({ ok: true, archivos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// VERIFICACIÓN
// ============================================================
let verifState = { running: false, paused: false, progress: 0, total: 0, results: [], log: [], _pendingRegistros: [], _pendingConfig: null };

async function ejecutarVerificacion(registros, config, startFrom = 0) {
  const delay = config.delay || 500;
  for (let i = startFrom; i < registros.length; i++) {
    if (verifState.paused) {
      verifState.log.push({ tipo: 'warn', msg: `Pausado en registro ${i + 1} de ${registros.length}` });
      verifState._pendingRegistros = registros;
      verifState._pendingConfig = config;
      verifState._pausedAt = i;
      return;
    }
    const r = registros[i];
    const dominio = r.UDOMINIO || '';
    try {
      if (!dominio) throw new Error('Sin dominio');
      const apiResp = await consultarPatente(dominio, config);
      const clasif = clasificarPatente(r, apiResp, config);
      verifState.results.push({ registro: r, apiResponse: apiResp, clasificacion: clasif });
      verifState.log.push({ tipo: 'ok', msg: `${dominio} → ${clasif.texto}` });
    } catch (e) {
      verifState.results.push({ registro: r, apiResponse: null, clasificacion: { codigo: 'PENDIENTE', texto: 'Error: ' + e.message, pecNombre: '-', tallerNombre: '-', tallerCodigo: '-', pecCodigo: '-', fechaOp: '-', nuevoVto: '-' } });
      verifState.log.push({ tipo: 'err', msg: `${dominio} → ${e.message}` });
    }
    verifState.progress = i + 1;
    if (i < registros.length - 1) await new Promise(r => setTimeout(r, delay));
  }
  verifState.running = false;
  verifState._pendingRegistros = [];
  verifState._pendingConfig = null;
}

app.post('/api/verificar/iniciar', async (req, res) => {
  const { registros, config } = req.body;
  if (verifState.running) return res.json({ ok: false, error: 'Ya hay una verificación en curso' });
  if (!config?.apiKey) return res.json({ ok: false, error: 'Falta API Key' });

  verifState = { running: true, paused: false, progress: 0, total: registros.length, results: [], log: [], _pendingRegistros: [], _pendingConfig: null };
  res.json({ ok: true, total: registros.length });

  ejecutarVerificacion(registros, config, 0);
});

app.post('/api/verificar/pausar', (req, res) => {
  verifState.paused = true;
  res.json({ ok: true });
});

app.post('/api/verificar/reanudar', (req, res) => {
  if (verifState.running && !verifState.paused) return res.json({ ok: false, error: 'Ya está corriendo' });
  if (!verifState._pendingRegistros?.length) return res.json({ ok: false, error: 'No hay verificación pausada para reanudar' });

  verifState.paused = false;
  verifState.running = true;
  verifState.log.push({ tipo: 'info', msg: `Reanudando desde registro ${verifState._pausedAt + 1}` });
  res.json({ ok: true, resumeFrom: verifState._pausedAt });

  ejecutarVerificacion(verifState._pendingRegistros, verifState._pendingConfig, verifState._pausedAt);
});

app.get('/api/verificar/estado', (req, res) => {
  const lastLog = parseInt(req.query.lastLog) || 0;
  res.json({
    running: verifState.running,
    paused: verifState.paused,
    progress: verifState.progress,
    total: verifState.total,
    log: verifState.log.slice(lastLog),
    logOffset: verifState.log.length,
    results: !verifState.running ? verifState.results : undefined
  });
});

// ============================================================
// PERSISTENCIA DE PERIODOS
// ============================================================

app.post('/api/periodos', (req, res) => {
  try {
    const data = req.body;
    const saved = guardarPeriodo(data.periodoId, data);
    res.json({ ok: true, periodo: saved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/periodos', (req, res) => {
  res.json(listarPeriodos());
});

app.get('/api/periodos/:id', (req, res) => {
  const data = leerPeriodo(req.params.id);
  if (!data) return res.status(404).json({ error: 'Período no encontrado' });
  res.json(data);
});

app.delete('/api/periodos/:id', (req, res) => {
  try {
    eliminarPeriodo(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/historial', (req, res) => {
  res.json(generarHistorial());
});

// ============================================================
// CONFIG
// ============================================================
const CONFIG_PATH = path.join(__dirname, 'data', 'config.json');

app.get('/api/config', (req, res) => {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      res.json(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    } else {
      res.json({ apiUrl: 'https://consultas-gnc.arielxp.workers.dev', apiKey: '', delay: 500, pecPropios: ['3145', '3286'], talleresPropios: ['IRT0550', 'HIT0797'] });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/config', (req, res) => {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Logout
app.post('/api/logout', (req, res) => {
  const token = extraerToken(req);
  if (token) delete sessions[token];
  res.json({ ok: true });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  Sistema de Obleas GNC - Nova GNC`);
  console.log(`  Corriendo en http://localhost:${PORT}`);
  console.log(`  Clave de acceso: ${APP_CLAVE === 'nova2026' ? '⚠️  Usando clave default — cambiala con la variable de entorno APP_CLAVE' : '✅ Clave configurada por variable de entorno'}\n`);
});
