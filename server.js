const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { Pool } = require('pg');
const { procesarCompleto, procesarRows, normalizarLocalidad, parseCSV, dividirArchivos, canalLabel, telWhatsappValido, TALLERES_PROPIOS } = require('./lib/procesar');

// Las megatablas de ENARGAS/InfoSys vienen en latin-1 (ISO-8859). Si se leen como utf8 se
// corrompen ñ/tildes en nombres. Detectamos: si al decodificar utf8 aparece el carácter de
// reemplazo, era latin-1.
function decodeCsv(buf) {
  const utf8 = buf.toString('utf8');
  return utf8.includes('�') ? buf.toString('latin1') : utf8;
}
const { clasificarPatente, consultarPatente } = require('./lib/verificar');
const { guardarPeriodo, leerPeriodo, listarPeriodos, eliminarPeriodo, generarHistorial } = require('./lib/storage');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;

const COMUNICACIONES_HUB_URL = process.env.COMUNICACIONES_HUB_URL || 'https://n8n.srv803796.hstgr.cloud/webhook/comunicaciones';
const DALEGAS_API_URL = process.env.DALEGAS_API_URL || 'https://api.dalegas.com.ar';
const DALEGAS_API_KEY = process.env.DALEGAS_API_KEY || 'AppNovaSecret2026';
const INFORME_OBLEAS_API_KEY = process.env.INFORME_OBLEAS_API_KEY || 'SistemaObleas2026';
// API key para el endpoint de calidad de contactos (OB-3, proxy → api.dalegas.com.ar/api/calidad_contactos).
// La provee Enargas Scrap (registrada en gnc_api_keys). Overridear en .env de S18 cuando esté la definitiva.
const CALIDAD_API_KEY = process.env.CALIDAD_API_KEY || DALEGAS_API_KEY;
// API key del endpoint de export a ManyChat (lo consume GP-37/n8n sin sesión). Ver /api/export/manychat.
const MANYCHAT_EXPORT_API_KEY = process.env.MANYCHAT_EXPORT_API_KEY || 'NovaObleasManychat2026';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://192.168.0.18:3080/auth/google/callback';
// Dominios de la empresa. DEFENSA EN PROFUNDIDAD, NO autorización (OB-7 / CEO-64): sirve para
// descartar un gmail personal antes de pegarle a la DB, pero YA NO decide quién entra — eso lo
// gobierna panel.acceso_app (sección 'obleas' o super_admin). Sorvicor: Vanesa Urquia (coord_obleas).
const ALLOWED_DOMAINS = ['novagnc.com.ar', 'sorvicor.com.ar'];

// Pool PostgreSQL cdp_nova. Autoriza el login contra panel.acceso_app (función del panel, PN-75).
const pool = new Pool({
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'cdp_nova',
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 5000,
});

// Pool PostgreSQL enargas_data (para enriquecer UOBLEANEW al importar)
const poolEnargas = new Pool({
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT || '5432'),
  database: 'enargas_data',
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 5000,
});

// Enriquece UOBLEANEW desde historial_obleas_datos para registros que no lo tienen en el CSV
async function enriquecerObleas(normalizados) {
  // Determinar rango de vencimiento según UFECVENHAB del período
  // UFECVENHAB viene como "1/4/2026" (d/m/yyyy)
  const sinOblea = normalizados.filter(r => !r.UOBLEANEW);
  if (sinOblea.length === 0) return normalizados; // todos ya tienen oblea del CSV

  // Detectar el mes/año del período desde el primer registro con fecha
  let periodoStart = null, periodoEnd = null;
  const conFecha = normalizados.find(r => r.UFECVENHAB);
  if (conFecha) {
    const parts = conFecha.UFECVENHAB.split('/');
    if (parts.length === 3) {
      const mes = parseInt(parts[1]), anio = parseInt(parts[2]);
      // Rango: desde 15 días antes del mes hasta el último día del mes
      periodoStart = new Date(anio, mes - 1, 1); // 1ro del mes
      periodoStart.setDate(periodoStart.getDate() - 15); // 15 días antes
      periodoEnd = new Date(anio, mes, 1); // 1ro del mes siguiente
    }
  }
  if (!periodoStart) return normalizados; // no se pudo determinar el período

  const patentes = sinOblea.map(r => r.UDOMINIO).filter(Boolean);
  if (patentes.length === 0) return normalizados;

  try {
    const placeholders = patentes.map((_, i) => `$${i + 3}`).join(',');
    const query = `
      SELECT DISTINCT ON (patente) patente, numero_oblea
      FROM historial_obleas_datos
      WHERE vencimiento_oblea >= $1 AND vencimiento_oblea < $2
        AND patente IN (${placeholders})
      ORDER BY patente, vencimiento_oblea ASC
    `;
    const result = await poolEnargas.query(query, [periodoStart, periodoEnd, ...patentes]);
    const obleasMap = {};
    result.rows.forEach(r => { obleasMap[r.patente] = String(r.numero_oblea); });

    let enriquecidos = 0;
    normalizados.forEach(r => {
      if (!r.UOBLEANEW && obleasMap[r.UDOMINIO]) {
        r.UOBLEANEW = obleasMap[r.UDOMINIO];
        enriquecidos++;
      }
    });
    console.log(`[enriquecerObleas] ${enriquecidos}/${sinOblea.length} registros enriquecidos con UOBLEANEW desde enargas_data`);
  } catch (e) {
    console.error('[enriquecerObleas] Error consultando enargas_data (no bloqueante):', e.message);
    // No bloqueante: si falla, continúa sin el enriquecimiento
  }
  return normalizados;
}

// Talleres propios de Nova (GP5 + Sorvicor) — usados para acotar la importación desde base.
// FUENTE ÚNICA: se toma de procesar.js (TALLERES_PROPIOS) para que no haya dos listas que se
// contradigan. Antes acá estaba hardcodeada ['HIT0797','IRT0550','QUT0856','QUT0865'] — MAL:
// QUT0856/QUT0865 son talleres AJENOS (aparecían en un export mal armado) y faltaba QUT0867
// (Grupo P5). Eso hacía que el import trajera obleas de otros talleres y perdiera las de P5.
const NOVA_TALLERES = [...TALLERES_PROPIOS];

// Normaliza UFECVENHAB de nova_operaciones (dos fuentes: ISO 'YYYY-MM-DD...' o CSV 'DD/MM/YYYY')
// a un objeto Date. La conversión SQL ya se hace en la query; esto es defensivo.
const SQL_VENC_EXPR = `
  CASE
    WHEN datos_raw->>'UFECVENHAB' ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (left(datos_raw->>'UFECVENHAB',10))::date
    WHEN datos_raw->>'UFECVENHAB' ~ '^\\d{1,2}/\\d{1,2}/\\d{4}$' THEN to_date(datos_raw->>'UFECVENHAB','DD/MM/YYYY')
    ELSE NULL
  END`;

// Nombres legibles de taller (misma fuente que el frontend) y meses, para el export a ManyChat.
const TALLER_NOMBRES = { 'IRT0550': 'Nova Gral Paz', 'HIT0797': 'Nova R20', 'QUT0867': 'Grupo P5' };
const MESES_NOMBRE = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
function periodoLabel(id) {
  const [mes, anio] = String(id || '').split('-');
  const m = parseInt(mes, 10);
  return (MESES_NOMBRE[m] || mes) + (anio ? ' ' + anio : '');
}

// Vencimiento del PH (prueba hidráulica) de un vehículo = el más próximo entre sus cilindros.
// Cada cilindro (nova_operaciones.datos_raw._cilindros) trae la fecha del ÚLTIMO PH en CUPHANO
// (año 2 díg) / CUPHMES (mes). El PH vence a los 5 años (estándar ENARGAS para cilindros GNC,
// confirmado con Ariel 2026-08-13). Devuelve un Date (UTC, día 1 del mes) o null si no hay dato.
function phVenceDe(cilindros) {
  if (!Array.isArray(cilindros) || !cilindros.length) return null;
  let min = null;
  for (const c of cilindros) {
    const a = parseInt(c && c.CUPHANO, 10);
    const m = parseInt(c && c.CUPHMES, 10);
    if (!Number.isFinite(a) || !Number.isFinite(m) || m < 1 || m > 12) continue;
    const venc = new Date(Date.UTC(2000 + a + 5, m - 1, 1)); // último PH + 5 años
    if (min === null || venc < min) min = venc;
  }
  return min;
}

// Clasifica el vencimiento POR CONTACTO en 3 grupos (encargo OB-4, regla de Ariel 2026-08-14).
// Todas las patentes del período tienen la oblea venciendo el mes. Se separan por la PH MÁS
// CERCANA (el mínimo entre sus cilindros, ver phVenceDe), medida contra el venc. de la oblea:
//   ph_urgente    → PH vence dentro de los próximos 6 meses (incluye ya vencida). Aviso más fuerte.
//   ph            → PH vence entre el mes 7 y el 12.
//   solo_oblea    → PH vence después del mes 12 (solo se avisa la oblea).
//   ph_desconocido→ falta el dato del cilindro (ej. período cargado por CSV, que no trae cilindros).
function clasificarVencimiento(obleaVenc, phVence) {
  if (!phVence || !obleaVenc) return 'ph_desconocido';
  const mas = (n) => new Date(Date.UTC(obleaVenc.getUTCFullYear(), obleaVenc.getUTCMonth() + n, obleaVenc.getUTCDate()));
  if (phVence <= mas(6)) return 'ph_urgente';
  if (phVence <= mas(12)) return 'ph';
  return 'solo_oblea';
}

// Da forma al registro que consume el frontend (mismo shape para CSV y para base)
function mapRegistro(r) {
  return {
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
    UTELEFONO: r.UTELEFONO, UTELEFONO_ERROR: r.UTELEFONO_ERROR,
    UOBLEANEW: r.UOBLEANEW, UOBLEAANT: r.UOBLEAANT,
    _tipoGestion: r._tipoGestion,
    _phVence: r._phVence, _tipoVencimiento: r._tipoVencimiento,
    SUBTAL: r.SUBTAL
  };
}

// Sesiones en memoria: token → { ts, nombre, email, metodo }
const sessions = {};
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 horas

function generarToken() {
  return crypto.randomBytes(32).toString('hex');
}

function crearSesion(nombre, email, metodo, rol) {
  limpiarSesiones();
  const token = generarToken();
  sessions[token] = { ts: Date.now(), nombre, email, metodo, rol };
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

// El acceso por clave compartida (APP_CLAVE) se eliminó (OB-7 / CEO-64): el único login es
// Google + autorización del panel (panel.acceso_app). Ariel entra igual porque es super_admin.

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
    + '&hd=*'; // hint: cualquier cuenta Google Workspace (filtra gmail personal); el whitelist real se valida server-side
  res.redirect(url);
});

// Google OAuth — paso 2: callback
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, error } = req.query;
    console.log('[OAuth callback] code:', code ? 'PRESENTE' : 'AUSENTE', '| error:', error || 'ninguno');
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
    console.log('[OAuth callback] token exchange:', tokens.access_token ? 'OK' : 'FALLÓ', tokens.error || '');
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

    // Defensa en profundidad: descartar cuentas fuera de los dominios de la empresa ANTES de
    // pegarle a la DB (un gmail personal ni llega a consultar el panel). El dominio YA NO autoriza.
    const domain = googleUser.email.split('@')[1];
    if (!ALLOWED_DOMAINS.includes(domain)) return res.redirect('/login.html?error=domain_not_allowed');

    // AUTORIZACIÓN GOBERNADA POR EL PANEL (OB-7 / convención CEO-64).
    // La regla de acceso (bypass super_admin + activo + sección 'obleas') vive en la función
    // panel.acceso_app de cdp_nova = fuente única. Obleas solo consume `permitido` — no la
    // reimplementa. Reglas duras: NO auto-create y fail-closed (si la DB no responde, no entra nadie).
    let acceso;
    try {
      const r = await pool.query(
        'SELECT permitido, nombre, rol FROM panel.acceso_app($1, $2)',
        [googleUser.email, 'obleas']
      );
      acceso = r.rows[0]; // undefined = el email no está en panel.usuarios
    } catch (dbErr) {
      console.error('[OAuth callback] panel.acceso_app falló → fail-closed, rechazo:', dbErr.message);
      return res.redirect('/login.html?error=panel_no_disponible');
    }

    if (!acceso || !acceso.permitido) {
      console.log('[OAuth callback] acceso DENEGADO por el panel para:', googleUser.email);
      return res.redirect('/login.html?error=sin_acceso');
    }

    const nombre = acceso.nombre || googleUser.name || googleUser.email.split('@')[0];
    // Marcar último login (no bloqueante; no incide en la autorización, que ya pasó).
    pool.query('UPDATE panel.usuarios SET ultimo_login = NOW() WHERE email = $1', [googleUser.email]).catch(() => {});

    const token = crearSesion(nombre, googleUser.email, 'google', acceso.rol);
    console.log('[OAuth callback] sesión creada para:', googleUser.email, '| token:', token.slice(0,8) + '...');
    const usuarioJson = JSON.stringify({ nombre, email: googleUser.email, metodo: 'google' });

    res.setHeader('Set-Cookie', 'token=' + token + '; Path=/; Max-Age=86400; SameSite=Lax');
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
  // Endpoints de export máquina-a-máquina (los consume GP-37/n8n): auth por API key, sin sesión.
  if (req.path.startsWith('/api/export/')) {
    const key = req.headers['x-api-key'];
    if (key && key === MANYCHAT_EXPORT_API_KEY) return next();
    return res.status(401).json({ error: 'API key inválida o ausente (header X-API-Key)' });
  }
  const token = extraerToken(req);
  const sesion = sessions[token];
  console.log('[auth] path:', req.path, '| token:', token ? token.slice(0,8)+'...' : 'NINGUNO', '| sesion:', sesion ? 'OK' : 'NO ENCONTRADA', '| sessions activas:', Object.keys(sessions).length);
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

// Metadata de archivo para el frontend (sin el content pesado; incluye tipo y preview)
function archivoMeta(a) {
  return { name: a.name, tipo: a.tipo, records: a.records, period: a.period, version: a.version, preview: a.preview };
}

// Subir y procesar CSV(s). Acepta UNO o VARIOS archivos (Sorvicor + Gp5) → se unen en un período.
app.post('/api/procesar', upload.array('archivos', 10), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No se envió ningún archivo' });
    // parsear cada archivo (latin-1) y concatenar filas
    const rows = [];
    for (const f of files) rows.push(...parseCSV(decodeCsv(f.buffer)));

    const porArchivo = parseInt(req.body.porArchivo) || 50;
    const resultado = procesarRows(rows, { porArchivo });

    // Enriquecer UOBLEANEW desde enargas_data para registros que no lo traen en el CSV
    await enriquecerObleas(resultado.normalizados);

    res.json({
      ok: true,
      periodo: resultado.periodo,
      totalOriginal: resultado.totalOriginal,
      totalFiltrado: resultado.totalFiltrado,
      metricasOriginal: resultado.metricasOriginal,
      metricasFiltrado: resultado.metricasFiltrado,
      normalizacion: resultado.normalizacion,
      excluidosComisionista: resultado.excluidosComisionista,
      resumenTipo: resultado.resumenTipo,
      archivosCargados: files.map(f => f.originalname),
      archivos: resultado.archivos.map(archivoMeta),
      registros: resultado.normalizados.map(mapRegistro)
    });
  } catch (e) {
    console.error('Error procesando:', e);
    res.status(500).json({ error: e.message });
  }
});

// Regenerar archivos (con ediciones del operador y/o nueva cantidad por archivo)
app.post('/api/generar-archivos', (req, res) => {
  try {
    const { registros, porArchivo } = req.body;
    const archivos = dividirArchivos(registros, { porArchivo });
    res.json({ ok: true, archivos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// VERIFICACIÓN
// ============================================================
let verifState = { running: false, paused: false, progress: 0, total: 0, results: [], log: [], _pendingRegistros: [], _pendingConfig: null };

async function notificarLoteCompletado(periodoNombre, total, ok, errores) {
  const nombre = periodoNombre || 'Lote';
  const mensaje = `✅ Lote "${nombre}" completado\n• Total: ${total} patentes\n• OK: ${ok}\n• Errores: ${errores}`;
  try {
    await fetch(COMUNICACIONES_HUB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: 'nova-tecnico', mensaje }),
      signal: AbortSignal.timeout(10000)
    });
    console.log('[notificarLote] Notificación enviada al hub de comunicaciones');
  } catch (e) {
    console.error('[notificarLote] Error enviando notificación (no bloqueante):', e.message);
  }
}

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
  const _total = verifState.results.length;
  const _errores = verifState.results.filter(r => r.clasificacion.codigo === 'PENDIENTE').length;
  await notificarLoteCompletado(config.periodoNombre, _total, _total - _errores, _errores);
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
// LOTE — proxy → api.dalegas.com.ar
// ============================================================

app.post('/api/lote', async (req, res) => {
  try {
    const resp = await fetch(`${DALEGAS_API_URL}/api/lote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': DALEGAS_API_KEY },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(30000)
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/lote/:jobId', async (req, res) => {
  try {
    const resp = await fetch(`${DALEGAS_API_URL}/api/lote/${req.params.jobId}`, {
      headers: { 'X-API-Key': DALEGAS_API_KEY },
      signal: AbortSignal.timeout(30000)
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/notificar-lote', async (req, res) => {
  const { periodoNombre, total, ok, errores } = req.body;
  await notificarLoteCompletado(periodoNombre, total, ok, errores);
  res.json({ ok: true });
});

// ============================================================
// INFORME MENSUAL DE GESTIÓN DE OBLEAS (proxy → api.dalegas.com.ar)
// ============================================================

app.get('/api/informe-obleas', async (req, res) => {
  try {
    const mes = req.query.mes || '';
    const zona = req.query.zona || 'cordoba_ciudad';
    const url = `${DALEGAS_API_URL}/api/informe/obleas?mes=${encodeURIComponent(mes)}&zona=${encodeURIComponent(zona)}`;
    const resp = await fetch(url, {
      headers: { 'X-API-Key': INFORME_OBLEAS_API_KEY },
      signal: AbortSignal.timeout(30000)
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/informe-obleas/generar', async (req, res) => {
  try {
    const resp = await fetch(`${DALEGAS_API_URL}/api/informe/obleas/generar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': INFORME_OBLEAS_API_KEY },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(60000)
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/informe-obleas/serie', async (req, res) => {
  try {
    const zona = req.query.zona || 'cordoba_ciudad';
    const url = `${DALEGAS_API_URL}/api/informe/obleas/serie?zona=${encodeURIComponent(zona)}`;
    const resp = await fetch(url, {
      headers: { 'X-API-Key': INFORME_OBLEAS_API_KEY },
      signal: AbortSignal.timeout(30000)
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// CALIDAD DE CONTACTOS (OB-3, proxy → api.dalegas.com.ar/api/calidad_contactos)
// Fuente única del cálculo: Enargas Scrap. Acá solo se proxya con la API key
// del servidor (nunca se expone al browser) y se pasa scope/id/anio tal cual.
// ============================================================

app.get('/api/calidad-contactos', async (req, res) => {
  try {
    const scope = req.query.scope || '';
    const id = req.query.id || '';
    const anio = req.query.anio || '';
    if (scope !== 'taller' && scope !== 'comisionista') {
      return res.status(400).json({ error: "scope inválido (esperado: 'taller' o 'comisionista')" });
    }
    if (!id) return res.status(400).json({ error: 'Falta el parámetro id' });
    const qs = new URLSearchParams({ scope, id });
    if (anio) qs.set('anio', anio);
    const url = `${DALEGAS_API_URL}/api/calidad_contactos?${qs.toString()}`;
    const resp = await fetch(url, {
      headers: { 'X-API-Key': CALIDAD_API_KEY },
      signal: AbortSignal.timeout(30000)
    });
    // El upstream puede devolver 404 si el endpoint aún no está deployado; se propaga tal cual.
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = { error: 'Respuesta no-JSON del upstream', raw: text.slice(0, 300) }; }
    res.status(resp.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Opciones para los buscadores de la pantalla de calidad de contactos.
// Lee nova_operaciones (solo lectura; la tabla la mantiene Enargas Scrap) para
// enumerar talleres y comisionistas con su nombre. NO es el cálculo de calidad
// (eso vive en el endpoint upstream) — solo un listado de entidades para el picker.
app.get('/api/calidad-contactos/opciones', async (req, res) => {
  try {
    const scope = req.query.scope || '';
    if (scope === 'taller') {
      const q = `
        SELECT taller_codigo AS id,
               max(datos_raw->>'TRAZSOC') AS nombre,
               count(*)::int AS n
        FROM nova_operaciones
        WHERE coalesce(taller_codigo,'') <> ''
        GROUP BY taller_codigo
        ORDER BY n DESC`;
      const r = await poolEnargas.query(q);
      const opciones = r.rows.map(x => ({
        id: x.id, nombre: x.nombre || '(sin nombre)', n: x.n,
        es_nova: NOVA_TALLERES.includes(x.id)
      }));
      return res.json({ ok: true, scope, opciones });
    }
    if (scope === 'comisionista') {
      // Solo comisionistas que operan bajo un taller nuestro (audiencia del reporte).
      const q = `
        SELECT datos_raw->>'GNCOBS3' AS id,
               max(datos_raw->>'subtaller_nombre') AS nombre,
               max(datos_raw->>'TRAZSOC') AS taller,
               count(*)::int AS n
        FROM nova_operaciones
        WHERE coalesce(datos_raw->>'GNCOBS3','') <> ''
          AND taller_codigo = ANY($1)
        GROUP BY datos_raw->>'GNCOBS3'
        ORDER BY n DESC`;
      const r = await poolEnargas.query(q, [NOVA_TALLERES]);
      const opciones = r.rows.map(x => ({
        id: x.id, nombre: x.nombre || '(sin nombre)', taller: x.taller || '', n: x.n
      }));
      return res.json({ ok: true, scope, opciones });
    }
    return res.status(400).json({ error: "scope inválido (esperado: 'taller' o 'comisionista')" });
  } catch (e) {
    console.error('[calidad-contactos/opciones] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// IMPORTACIÓN DESDE BASE (nova_operaciones / InfoSys)
// ============================================================

// Meses disponibles (por vencimiento) con conteo de obleas vs PH — para el selector
app.get('/api/base/periodos', async (req, res) => {
  try {
    const q = `
      WITH base AS (
        SELECT datos_raw->>'UCODGEST' AS cod, ${SQL_VENC_EXPR} AS venc
        FROM nova_operaciones
        WHERE taller_codigo = ANY($1)
      )
      SELECT to_char(venc,'YYYY-MM') AS mes,
             count(*)::int AS total,
             count(*) FILTER (WHERE cod = 'X')::int AS ph,
             count(*) FILTER (WHERE cod IS DISTINCT FROM 'X')::int AS obleas
      FROM base
      WHERE venc IS NOT NULL
      GROUP BY 1
      ORDER BY 1 DESC`;
    const r = await poolEnargas.query(q, [NOVA_TALLERES]);
    res.json({ ok: true, periodos: r.rows });
  } catch (e) {
    console.error('[base/periodos] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Trae los registros de talleres Nova que vencen en el mes dado, ya procesados
// con la misma tubería del CSV. tipo: todos | oblea | ph
app.get('/api/base/importar', async (req, res) => {
  try {
    const mes = String(req.query.mes || '');
    const tipo = String(req.query.tipo || 'todos').toLowerCase();
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Parámetro "mes" inválido (formato YYYY-MM)' });

    const [y, m] = mes.split('-').map(Number);
    const desde = `${y}-${String(m).padStart(2, '0')}-01`;
    const hastaY = m === 12 ? y + 1 : y;
    const hastaM = m === 12 ? 1 : m + 1;
    const hasta = `${hastaY}-${String(hastaM).padStart(2, '0')}-01`;

    const q = `
      WITH base AS (
        SELECT patente, oblea_nueva, oblea_anterior, marca, modelo, ano, titular_nombre,
               titular_doc, titular_tel, direccion, localidad, provincia, taller_codigo,
               fecha_operacion, importado_en, datos_raw,
               datos_raw->>'UCODGEST' AS cod, ${SQL_VENC_EXPR} AS venc
        FROM nova_operaciones
        WHERE taller_codigo = ANY($1)
      ),
      enmes AS (
        SELECT * FROM base WHERE venc >= $2::date AND venc < $3::date
      )
      SELECT DISTINCT ON (patente) *
      FROM enmes
      ORDER BY patente, fecha_operacion DESC NULLS LAST, importado_en DESC NULLS LAST`;
    const r = await poolEnargas.query(q, [NOVA_TALLERES, desde, hasta]);

    // DB → shape de fila CSV (objetos U*)
    const rows = r.rows.map(row => {
      const d = row.datos_raw || {};
      const esPH = row.cod === 'X';
      const v = row.venc ? new Date(row.venc) : null;
      const fmtFecha = v ? `${v.getUTCDate()}/${v.getUTCMonth() + 1}/${v.getUTCFullYear()}` : '';
      // Clasificación por contacto oblea vs oblea+PH (OB-4), a partir de los cilindros del vehículo.
      const phVence = phVenceDe(d._cilindros);
      return {
        _phVence: phVence ? phVence.toISOString().slice(0, 10) : null,
        _tipoVencimiento: clasificarVencimiento(v, phVence),
        UFECVENHAB: fmtFecha,
        UDOMINIO: d.UDOMINIO || row.patente || '',
        UOBLEANEW: d.UOBLEANEW || row.oblea_nueva || '',
        UOBLEAANT: d.UOBLEAANT || row.oblea_anterior || '',
        UMARCA: d.UMARCA || row.marca || '',
        UMODELO: d.UMODELO || row.modelo || '',
        UANO: d.UANO || (row.ano != null ? String(row.ano) : ''),
        UAPEYNOM: d.UAPEYNOM || row.titular_nombre || '',
        UCALLEYNRO: d.UCALLEYNRO || row.direccion || '',
        ULOCALIDAD: normalizarLocalidad(d.ULOCALIDAD || row.localidad || ''),
        UPROVINCIA: normalizarLocalidad(d.UPROVINCIA || row.provincia || ''),
        UCODPOSTAL: d.UCODPOSTAL || '',
        UTELEFONO: d.UTELEFONO || row.titular_tel || '',
        UTIPDOC: d.UTIPDOC || '',
        UNRODOC: d.UNRODOC || row.titular_doc || '',
        GNCOBS3: d.GNCOBS3 || '',
        SUBTAL: d.SUBTAL || '',
        // Nombre legible del comisionista (InfoSys lo trae en subtaller_nombre: MANSILLA, MOSTRADOR…).
        COMISIONISTA_NOMBRE: d.subtaller_nombre || '',
        TCODTAL: d.TCODTAL || row.taller_codigo || '',
        GNCOBS1: d.GNCOBS1 || d.subtaller_nombre || row.taller_codigo || '',
        // UCODGEST alimenta tipoGestion() dentro de procesarRows (X = PH, resto = oblea).
        UCODGEST: d.UCODGEST || (esPH ? 'X' : ''),
        _tipoGestion: esPH ? 'PH' : 'OBLEA'
      };
    });

    const conteo = {
      total: rows.length,
      obleas: rows.filter(x => x._tipoGestion === 'OBLEA').length,
      ph: rows.filter(x => x._tipoGestion === 'PH').length
    };

    let seleccion = rows;
    if (tipo === 'oblea') seleccion = rows.filter(x => x._tipoGestion === 'OBLEA');
    else if (tipo === 'ph') seleccion = rows.filter(x => x._tipoGestion === 'PH');

    // NO pasar yaFiltrado: la megatabla nova_operaciones trae, para un taller nuestro, tanto
    // clientes directos/comisionistas propios COMO comisionistas externos que usan nuestro PEC.
    // procesarRows aplica filtrar() → Original = todo lo del taller (todos los comisionistas),
    // Filtrado = solo comisionista propio. Igual que el CSV "Vencimientos Usuarios".
    const resultado = procesarRows(seleccion);

    res.json({
      ok: true,
      fuente: 'infosys',
      mes,
      tipo,
      conteo,
      periodo: resultado.periodo,
      totalOriginal: resultado.totalOriginal,
      totalFiltrado: resultado.totalFiltrado,
      metricasOriginal: resultado.metricasOriginal,
      metricasFiltrado: resultado.metricasFiltrado,
      normalizacion: resultado.normalizacion,
      excluidosComisionista: resultado.excluidosComisionista,
      resumenTipo: resultado.resumenTipo,
      archivos: resultado.archivos.map(archivoMeta),
      registros: resultado.normalizados.map(mapRegistro)
    });
  } catch (e) {
    console.error('[base/importar] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// EXPORT A MANYCHAT (encargo OB-4) — lo consume GP-37/n8n para inyectar contactos
// ============================================================
// Devuelve la lista de contactos de un período GUARDADO (audiencia del broadcast = comisionista
// propio, con las correcciones de teléfono que hizo Yhonny) más la clasificación por contacto
// tipo_vencimiento ∈ { solo_oblea, oblea_y_ph, ph_desconocido }. Auth por X-API-Key (authMiddleware).
// El período tiene que haberse importado desde InfoSys y guardado (💾): el CSV no trae cilindros,
// así que un período subido por CSV sale como ph_desconocido.
app.get('/api/export/manychat', (req, res) => {
  try {
    const periodo = String(req.query.periodo || '').trim();
    if (!periodo) return res.status(400).json({ error: 'Falta el parámetro "periodo" (ej. 8-2026)' });
    const data = leerPeriodo(periodo);
    if (!data) return res.status(404).json({ error: `Período "${periodo}" no encontrado. Importalo desde InfoSys y guardalo primero.` });

    const registros = data.registros || [];
    const contactos = [];
    for (const r of registros) {
      const wa = telWhatsappValido(r);   // solo teléfonos WhatsApp válidos (549…), como el export a CSV
      if (!wa) continue;
      contactos.push({
        nombre: (r.UAPEYNOM || '').trim(),   // InfoSys lo trae como "APELLIDO NOMBRE" en un solo campo
        telefono: wa,
        patente: r.UDOMINIO || '',
        marca: r.UMARCA || '',
        modelo: r.UMODELO || '',
        ano: r.UANO || '',
        tipo_vencimiento: r._tipoVencimiento || 'ph_desconocido',
        taller: r.TCODTAL || '',
        taller_nombre: TALLER_NOMBRES[r.TCODTAL] || r.TCODTAL || '',
        periodo: periodoLabel(periodo)
      });
    }
    const resumen = contactos.reduce((a, c) => { a[c.tipo_vencimiento] = (a[c.tipo_vencimiento] || 0) + 1; return a; }, {});
    res.json({
      ok: true,
      periodo,
      periodo_label: periodoLabel(periodo),
      generado_en: new Date().toISOString(),
      total: contactos.length,
      resumen_tipo_vencimiento: resumen,
      contactos
    });
  } catch (e) {
    console.error('[export/manychat] error:', e);
    res.status(500).json({ error: e.message });
  }
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

// ============================================================
// PRE-CARGA EN WORKER
// ============================================================

app.post('/api/precarga', async (req, res) => {
  try {
    const { obleas } = req.body;
    if (!Array.isArray(obleas) || obleas.length === 0) {
      return res.status(400).json({ error: 'Falta lista de obleas' });
    }
    const cfg = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
    const apiUrl = cfg.apiUrl || 'https://consultas-gnc.arielxp.workers.dev';
    const apiKey = cfg.apiKey || '';
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['X-API-Key'] = apiKey;
    const resp = await fetch(`${apiUrl}/api/consulta-oblea`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ obleas }),
      signal: AbortSignal.timeout(300000)
    });
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  console.log(`  Acceso: Google OAuth + autorización del panel (panel.acceso_app, sección 'obleas')\n`);
});
