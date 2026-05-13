const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { Pool } = require('pg');
const { procesarCompleto } = require('./lib/procesar');
const { clasificarPatente, consultarPatente } = require('./lib/verificar');
const { guardarPeriodo, leerPeriodo, listarPeriodos, eliminarPeriodo, generarHistorial } = require('./lib/storage');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;

const APP_CLAVE = process.env.APP_CLAVE || 'nova2026';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://192.168.0.18:3080/auth/google/callback';
const ALLOWED_DOMAIN = 'novagnc.com.ar';

// Pool PostgreSQL cdp_nova (solo para verificar/crear usuarios Google)
const pool = new Pool({
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'cdp_nova',
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 5000,
});

// Sesiones en memoria: token → { ts, nombre, email, metodo }
const sessions = {};
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 horas

function generarToken() {
  return crypto.randomBytes(32).toString('hex');
}

function crearSesion(nombre, email, metodo) {
  limpiarSesiones();
  const token = generarToken();
  sessions[token] = { ts: Date.now(), nombre, email, metodo };
  return token;
}

function limpiarSesiones() {
  const now = Date.now();
  Object.keys(sessions).forEach(t => { if (now - sessions[t].ts > SESSION_DURATION) delete sessions[t]; });
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ============================================================
// AUTH
// ============================================================

// Login con clave (fallback de emergencia)
app.post('/api/login', (req, res) => {
  const { clave } = req.body;
  if (clave === APP_CLAVE) {
    const token = crearSesion('Admin', '', 'clave');
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

// Google OAuth — paso 1: redirigir a Google
app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(500).send('Google OAuth no configurado');
  const url = 'https://accounts.google.com/o/oauth2/v2/auth'
    + '?client_id=' + GOOGLE_CLIENT_ID
    + '&redirect_uri=' + encodeURIComponent(GOOGLE_REDIRECT_URI)
    + '&response_type=code'
    + '&scope=' + encodeURIComponent('openid email profile')
    + '&access_type=offline'
    + '&prompt=select_account'
    + '&hd=' + ALLOWED_DOMAIN;
  res.redirect(url);
});

// Google OAuth — paso 2: callback
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error || !code) return res.redirect('/login.html?error=google_denied');

    // Intercambiar code por access_token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      console.error('Google token error:', tokens);
      return res.redirect('/login.html?error=token_failed');
    }

    // Obtener datos del usuario
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + tokens.access_token }
    });
    const googleUser = await userRes.json();
    if (!googleUser.email) return res.redirect('/login.html?error=no_email');

    // Verificar dominio
    const domain = googleUser.email.split('@')[1];
    if (domain !== ALLOWED_DOMAIN) return res.redirect('/login.html?error=domain_not_allowed');

    // Buscar o crear usuario en panel.usuarios (cdp_nova)
    let nombre = googleUser.name || googleUser.email.split('@')[0];
    try {
      const existing = await pool.query(
        'SELECT id, nombre FROM panel.usuarios WHERE email = $1 AND activo = true',
        [googleUser.email]
      );
      if (existing.rows.length > 0) {
        nombre = existing.rows[0].nombre || nombre;
        await pool.query(
          'UPDATE panel.usuarios SET ultimo_login = NOW(), nombre = $1 WHERE id = $2',
          [googleUser.name || nombre, existing.rows[0].id]
        ).catch(() => {});
      } else {
        // Auto-crear con rol básico
        await pool.query(
          "INSERT INTO panel.usuarios (nombre, email, password_hash, rol, secciones_permitidas, activo) VALUES ($1, $2, 'google_oauth', 'operador', '{dashboard}', true)",
          [nombre, googleUser.email]
        ).catch(() => {});
      }
    } catch (dbErr) {
      console.error('DB error en Google callback (no bloqueante):', dbErr.message);
      // Continuar igual: si la DB falla, el dominio ya fue verificado
    }

    const token = crearSesion(nombre, googleUser.email, 'google');
    const usuarioJson = JSON.stringify({ nombre, email: googleUser.email, metodo: 'google' });

    res.setHeader('Set-Cookie', 'token=' + token + '; Path=/; Max-Age=86400; SameSite=Strict');
    res.send('<!DOCTYPE html><html><body><script>'
      + 'localStorage.setItem("token","' + token + '");'
      + 'localStorage.setItem("usuario",' + JSON.stringify(usuarioJson) + ');'
      + 'window.location.replace("/");'
      + '</script></body></html>');
  } catch (err) {
    console.error('Google callback error:', err);
    res.redirect('/login.html?error=server_error');
  }
});

// Middleware de autenticación
function authMiddleware(req, res, next) {
  const token = extraerToken(req);
  const sesion = sessions[token];
  if (sesion && (Date.now() - sesion.ts < SESSION_DURATION)) {
    sesion.ts = Date.now(); // renovar
    req.sesion = sesion;
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'No autenticado', redirect: '/login' });
  }
  return res.redirect('/login');
}

function extraerToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/token=([a-f0-9]{64})/);
  return match ? match[1] : null;
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
    if (verifState.paused || verifState.cancelled) {
      if (verifState.cancelled) {
        verifState.log.push({ tipo: 'warn', msg: 'Verificación cancelada.' });
        verifState.running = false;
        verifState.cancelled = false;
      } else {
        verifState.log.push({ tipo: 'warn', msg: `Pausado en registro ${i + 1} de ${registros.length}` });
        verifState._pendingRegistros = registros;
        verifState._pendingConfig = config;
        verifState._pausedAt = i;
        verifState.running = false; // liberar para poder reanudar o iniciar nueva
      }
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
  // Permitir iniciar si está pausado (ya tiene running=false) pero no si está activamente corriendo
  if (verifState.running && !verifState.paused) return res.json({ ok: false, error: 'Ya hay una verificación en curso' });
  if (!config?.apiKey) return res.json({ ok: false, error: 'Falta API Key' });

  verifState = { running: true, paused: false, progress: 0, total: registros.length, results: [], log: [], _pendingRegistros: [], _pendingConfig: null };
  res.json({ ok: true, total: registros.length });

  ejecutarVerificacion(registros, config, 0);
});

app.post('/api/verificar/pausar', (req, res) => {
  verifState.paused = true;
  // running se pondrá false en el próximo ciclo del loop
  res.json({ ok: true });
});

app.post('/api/verificar/reanudar', (req, res) => {
  if (!verifState._pendingRegistros?.length) return res.json({ ok: false, error: 'No hay verificación pausada para reanudar' });
  verifState.paused = false;
  verifState.running = true;
  verifState.log.push({ tipo: 'info', msg: `Reanudando desde registro ${verifState._pausedAt + 1}` });
  res.json({ ok: true, resumeFrom: verifState._pausedAt });
  ejecutarVerificacion(verifState._pendingRegistros, verifState._pendingConfig, verifState._pausedAt);
});

app.post('/api/verificar/cancelar', (req, res) => {
  verifState.cancelled = true;
  verifState.paused = false;
  // Si ya no está corriendo, reseteamos directamente
  if (!verifState.running) {
    verifState = { running: false, paused: false, cancelled: false, progress: 0, total: 0, results: verifState.results, log: verifState.log, _pendingRegistros: [], _pendingConfig: null };
  }
  res.json({ ok: true });
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
