# sistema-obleas — Instrucciones para Claude

## Qué es esto

Procesador de CSVs de obleas GNC exportados de ENARGAS. Clasifica vehículos según si renovaron en Nova (GP5/Sorvicor) o no. Deployado en producción.

**URL pública:** https://obleas.novagnc.com.ar  
**GitHub:** arielxp1978/sistema-obleas-app  
**Acceso (OB-7 / CEO-64, 2026-08-14):** Login **Google + autorización del panel**. Tras el OAuth, el callback consulta por SQL directo `SELECT permitido, nombre, rol FROM panel.acceso_app(email,'obleas')` (función del panel en `cdp_nova`, fuente única de la regla de acceso). Entra solo si `permitido=true` (usuario `activo` con la sección `obleas`, o `super_admin` como Ariel). **Ya NO se auto-crea usuario**, **NO hay clave de emergencia** (`APP_CLAVE` eliminado) y es **fail-closed** (si la DB/panel no responde → rechazo). El **dominio** (`ALLOWED_DOMAINS = novagnc.com.ar, sorvicor.com.ar`) quedó solo como defensa en profundidad (descarta gmail personal antes de consultar) — ya NO decide quién entra. Para dar acceso a alguien: tildarle la sección `obleas` en el panel (`usuarios.html`). Casos: Vanesa Urquia (`vurquia@sorvicor.com.ar`, coord_obleas, tiene `obleas`) entra; Nahir Alarcon (sin la sección) es rechazada con mensaje claro.

---

## CRÍTICO — Estructura de directorios (aprendido 2026-05-15)

Hay DOS estructuras distintas que NO son iguales:

### Local (Mac — para editar y commitear)
```
/Users/arielpalomeque/Documents/App Creadas/sistema-obleas/
  app/                    ← carpeta de la app Node.js
    server.js
    lib/
      verificar.js
      procesar.js
      normalizar.js
      storage.js
    public/
      index.html
      login.html
      historial.html
    data/                 ← gitignored, no existe localmente
    package.json
```

### S18 — donde corre Docker (192.168.0.18 / Tailscale: 100.72.42.104)
```
/home/akeneo/sistema-obleas-app/    ← raíz del repo en S18
  server.js               ← los archivos están en la RAÍZ, sin carpeta app/
  lib/
    verificar.js
    procesar.js
  public/
    index.html
  data/periodos/          ← períodos guardados, persisten en el host
  docker-compose.yml
  Dockerfile
```

### Por qué difieren

El repo local tiene una carpeta `app/` intermedia que no existe en S18. En S18 el repo se clonó directamente en `sistema-obleas-app/` con los archivos en la raíz.

### Protocolo correcto para deployar cambios

**⚠️ CORREGIDO 2026-07-17:** el `docker-compose.yml` usa `build: .` y **copia el código dentro de la imagen** (solo monta `obleas-data:/app/data`). Por eso **`docker compose restart` NO alcanza para NINGÚN cambio de código — ni siquiera `index.html`.** La instrucción vieja que decía "index.html solo restart" era falsa: los scp quedaban en el disco del host pero el container seguía sirviendo el código viejo de la imagen. **SIEMPRE hay que rebuild.**

**S18 puede acceder por Tailscale (100.72.42.104) o IP local (192.168.0.18, si estás en la red/VPN). El Tailscale a veces da timeout; la IP local con VPN Nova 1 conectada anda.**

```bash
# 1. scp de TODOS los archivos cambiados (backend Y frontend):
scp "app/lib/procesar.js"      akeneo@192.168.0.18:/home/akeneo/sistema-obleas-app/lib/procesar.js
scp "app/server.js"            akeneo@192.168.0.18:/home/akeneo/sistema-obleas-app/server.js
scp "app/public/index.html"    akeneo@192.168.0.18:/home/akeneo/sistema-obleas-app/public/index.html

# 2. SIEMPRE rebuild (restart no basta — el código se copia en la imagen):
ssh akeneo@192.168.0.18 "cd /home/akeneo/sistema-obleas-app && docker compose down && docker compose up -d --build"

# 3. reconectar el tunnel (ver abajo) y verificar HTTP 200.
```

Para confirmar que el código nuevo quedó DENTRO del container (no solo en el host):
```bash
ssh akeneo@192.168.0.18 "docker exec sistema-obleas grep -c '<algo del cambio>' /app/lib/procesar.js"
```

**Después de rebuild — reconectar el tunnel:**
```bash
ssh akeneo@100.72.42.104 "docker network connect sistema-obleas-app_default cloudflare-tunnel"
# Si dice "already exists" → bien, ya estaba conectado
```

**Verificar que todo anda:**
```bash
curl -s -o /dev/null -w "%{http_code}" https://obleas.novagnc.com.ar/login
# Debe devolver 200
```

---

## Infraestructura

| Componente | Detalle |
|---|---|
| App | Node.js + Express, puerto 3000 interno |
| Docker | `docker-compose.yml` en S18, imagen `sistema-obleas-app-obleas` |
| Red Docker | `sistema-obleas-app_default` |
| Cloudflare Tunnel | Container `cloudflare-tunnel`, expone el servicio como `obleas.novagnc.com.ar` |
| Tunnel ID | `4e11205e-000d-44a0-9a0e-e9b6426e701f` (mismo tunnel que Turnos-Web-GNC) |
| Google OAuth | Client ID: `961985612789-...`, redirect: `https://obleas.novagnc.com.ar/auth/google/callback` |
| PostgreSQL cdp_nova | VPS Hostinger, tabla `panel.usuarios` para autorización de usuarios |
| PostgreSQL enargas_data | VPS Hostinger, mismas creds, usado para enriquecer `UOBLEANEW` al importar CSV |
| Datos persistentes | `/home/akeneo/sistema-obleas-app/data/` (host, no en imagen) |

---

## Acceso a S18

```bash
# Por Tailscale (desde cualquier lugar)
ssh akeneo@100.72.42.104

# Por IP local (solo en red Nova)
ssh akeneo@192.168.0.18

# Clave: Akeneo123.
```

---

## Flujo de verificación (implementado 2026-05-22)

La verificación usa el sistema de lotes de `api.dalegas.com.ar` (S14). El flujo anterior (patente por patente vía `/api/consulta`) está deprecado pero el código del servidor lo mantiene por compatibilidad.

### Flujo actual (batch via /api/lote)

1. Usuario sube CSV → `POST /api/procesar` → procesa + enriquece UOBLEANEW automáticamente
2. Usuario hace click en "▶ Iniciar Verificación"
3. Frontend hace `POST /api/lote` (proxy en server.js) con todas las patentes + obleas
4. Recibe `job_id` y empieza polling `GET /api/lote/:jobId` cada 12 segundos
5. Resultados se muestran en tiempo real a medida que llegan (cache primero, S14 después)
6. Al completar: notificación automática al grupo **Nova Técnico** vía hub de comunicaciones
7. Resultados clasificados con `clasificarItemLote()` en el frontend

### Proxy en server.js (agregado 2026-05-22)

```
POST /api/lote        → proxy a https://api.dalegas.com.ar/api/lote
GET  /api/lote/:jobId → proxy a https://api.dalegas.com.ar/api/lote/:jobId
POST /api/notificar-lote → dispara notificación a hub comunicaciones (lo llama el frontend al completar)
```

La API key (`DALEGAS_API_KEY`) vive en el servidor, no se expone al browser.

### Formato del request al lote

```json
{
  "nombre": "Obleas Abril 2026",
  "patentes": [
    {"patente": "VDE405", "oblea": 47628377},
    {"patente": "LPU381", "oblea": 47145715}
  ],
  "force": false
}
```

**`oblea`**: número de oblea del período (UOBLEANEW del CSV). Se envía junto con la patente. NO omitir.

### Formato de respuesta del lote (IMPORTANTE — distinto al encargo original)

El encargo original decía `resultado.datos.pec_codigo` pero el formato real es **idéntico al viejo `/api/consulta?formato=enargas`**:

```javascript
// item de resultados:
{
  patente: "PMM907",
  oblea: 47682790,
  status: "ok" | "pendiente" | "error",
  fuente: "cache" | "s14" | null,
  resultado: {
    error: 0,           // 0=ok, 2=sin GNC, 4=procesando, 8=baja
    data: {
      datosPEC: { codigo: "3145", razonSocial: "SORVICOR S.R.L." },
      datosTaller: { codigo: "IRT0550", razonSocial: "SORVICOR S.R.L." },
      datosOperacion: { fechaHabilitacion: "...", fechaVencimiento: "..." }
    }
  },
  error: "Mensaje si status=error"   // ENARGAS_TRANSITORIO, Cruce de datos, etc.
}
```

### Tipos de error conocidos en el lote

| Error | Causa | Solución |
|---|---|---|
| `ENARGAS_TRANSITORIO` | ENARGAS no respondió por saturación temporal | Reintentar (botón "Reintentar fallidos") |
| `Cruce de datos` | El número de oblea enviado pertenece a otra patente en ENARGAS. En el scraper viejo era un falso positivo por timing (HTML no cargado). Con el scanner nuevo debería ser un error de datos real en el CSV | Verificar manualmente |
| `SIC_FAILED` | Similar al cruce de datos | Verificar manualmente |

### Completado del job

El job puede tardar desde minutos (cache caliente) hasta horas (muchos items en S14).
- `status: "completado"` de la API = terminó
- Fallback: si `resueltos >= total` y `total > 0` → también cierra el polling

### Notificación al completar

Al terminar, el frontend llama `POST /api/notificar-lote` que envía a Nova Técnico (Telegram):
```
✅ Lote "Obleas Abril 2026" completado
• Total: 505 patentes
• OK: 356
• Errores: 149
```
Hub: `https://n8n.srv803796.hstgr.cloud/webhook/comunicaciones` con `{"tipo":"nova-tecnico","mensaje":"..."}`.
Filtro horario 7am–midnight ART en el hub (si termina de madrugada, el mensaje se descarta).

---

## Recuperar una verificación ya corrida (job existente) — 2026-07-13

Los resultados de cada verificación viven en el **job de dalegas** (`api.dalegas.com.ar`), con id = slug del nombre del período (`"Obleas Mayo 2026"` → `obleas-mayo-2026`). El período JSON solo guarda la verificación si se aprieta 💾 **después** de correrla; si no, queda `verificacion: null` — pero **el job de dalegas la conserva igual**.

Por eso, al apretar "Iniciar Verificación" sobre un período que ya se verificó, la app detecta el job existente y ofrece (frontend, `iniciarVerificacion`):
1. **Ver los resultados guardados** (default, NO destructivo) → `cargarJobExistente()` hace polling del job existente y los renderiza. Ahí se aprieta 💾 para persistirlos en el período.
2. **Re-analizar de cero** (segundo confirm, DESTRUCTIVO) → `force:true`, descarta el job anterior.

`STATE._verifSoloVer` distingue "solo ver" de "corrida nueva" para no re-notificar a Telegram al cargar un job existente. `slugifyJob()` deriva el id igual que dalegas.

## Escape para jobs trabados + incidente dalegas — 2026-07-14/15

### El problema (incidente Mayo 2026)
El sistema de lotes de dalegas tenía un bug: cuando un job terminaba con **alguna** patente en error, el contador de finalización quedaba off-by-one y el job **nunca pasaba a `"completado"`** — quedaba clavado en `"procesando"` para siempre. Consecuencia: `POST /api/lote` con el mismo nombre devolvía **409 conflict incluso con `force:true`**, así que el período **no se podía re-verificar ni forzar de cero**. Yhonny quedó bloqueada con el reporte de Mayo (65 de 455 con error → job trabado → "Error: conflict" en seco).

### Fix del lado de la app (`iniciarVerificacion` en `public/index.html`)
Escape de cliente: si al elegir "re-analizar de cero" el `force:true` **igual** devuelve conflict (job trabado), la app ofrece relanzar la verificación bajo un **nombre único** (`"<nombre> v<AAAAMMDD-HHMM>"` vía `nuevoSufijoJob()`) → slug nuevo que no choca con el trabado. Así el usuario nunca queda sin salida. Es un **parche del consumidor**, defensivo — no reemplaza el arreglo del backend.

### Fix del lado del backend (encargo ES-15 a Enargas Scrap — cerrado)
La causa raíz se arregló en dalegas (`api.dalegas.com.ar`, VPS:5000), dueño = Enargas Scrap:
- **Bug de conteo**: jobs con errores ahora sí pasan a `"completado"` (verificado: los 2 jobs de Mayo cerraron con errores incluidos).
- **`DELETE /api/lote/:jobId`**: ahora existe (devuelve 200; antes 405). Permite borrar/destrabar un job manualmente con la API key.
- El escape-hatch de la app queda igual como defensa en profundidad, aunque el backend ya no debería trabar jobs.

## Clasificación en el frontend (clasificarItemLote)

```
status=pendiente → PENDIENTE (Verificando...)
status=error     → ERROR_TECNICO (texto del error)
resultado.error=2 → NO_RENOVO
resultado.error=8 → BAJA_GNC
resultado.error=4 → PROCESANDO
resultado.error=0 → clasificar por PEC y Taller:
  PEC en [3145,3286] + Taller en [IRT0550,HIT0797,QUT0856] → NUESTRO_PEC_NUESTRO_TALLER
  PEC en [3145,3286] solo                                   → NUESTRO_PEC_OTRO_TALLER
  otro                                                       → OTRO_PEC
```

**Talleres Nova**: IRT0550 (Sorvicor), HIT0797 (Nova GNC), **QUT0856** (también de Nova, confirmado 2026-05-22).

---

## UOBLEANEW — número de oblea del período

### Qué es

El número de oblea que tenía el vehículo en el período del CSV (la que estaba venciendo). Se usa para enviar al worker en el sistema de lotes.

### De dónde viene

1. **Del CSV de ENARGAS** (si el archivo lo trae): campo `UOBLEANEW` capturado automáticamente en `KEEP_COLS`.
2. **De enargas_data** (enriquecimiento automático): al importar un CSV, `server.js` consulta `historial_obleas_datos` buscando la oblea con `vencimiento_oblea` en el rango del período. Si encuentra, la agrega.

### Lógica de enriquecimiento (server.js — `enriquecerObleas()`)

```
Período del CSV → UFECVENHAB → mes/año → rango [mes-15d, mes+1)
Para cada patente sin UOBLEANEW:
  SELECT DISTINCT ON (patente) patente, numero_oblea
  FROM historial_obleas_datos
  WHERE vencimiento_oblea >= [inicio] AND vencimiento_oblea < [fin]
  ORDER BY patente, vencimiento_oblea ASC
```

**No bloqueante:** si falla la consulta a enargas_data, el CSV se procesa igual sin el campo.

---

## Lógica de clasificación legacy (verificar.js — modo patente por patente)

Mantenida por compatibilidad pero no se usa en el flujo actual.

| Resultado | Condición |
|---|---|
| **Nuestro PEC + Nuestro Taller** | `fechaVencimiento` nueva oblea > `UFECVENHAB` Y PEC = 3145/3286 Y Taller = IRT0550/HIT0797 |
| **Nuestro PEC + Taller Externo** | Igual pero taller no es de Nova |
| **Otro PEC** | Renovó pero en PEC externo |
| **No Renovó** | No hay operación posterior al vencimiento |

**IMPORTANTE:** La comparación usa `fechaVencimiento` (no `fechaHabilitacion`).

---

## Formato del CSV + pipeline de export ManyChat (reescrito 2026-07-17)

### El archivo correcto: reporte "Vencimientos Usuarios"
El CSV que se sube se saca de **InfoSys → Listados → Vencimientos Usuarios** (exportar CSV).
- **66 columnas**, encoding **latin-1** (ISO-8859), separador `;`, line endings CRLF.
- Header: `Vino?;Oblea Entregada;...;GNCOBS1;GNCOBS2;GNCOBS3;...;TCODTAL;notas;email;celular;...` (ver muestra `../Full 202507.csv`).
- Trae **dos capas**: técnica ENARGAS (oblea, fechas) + **comercial InfoSys** (vendedor `GNCOBS1`, comisionista `GNCOBS3`, teléfono).

**OJO — hubo confusión de formatos (2026-07-17):** existe OTRO export de InfoSys de **144 columnas** con `SUBTAL` (comisionista) y sin `GNCOBS1`. NO es el que se usa para ManyChat. La app **tolera ambos** (ver `getComisionista`), pero el bueno es el de 66-col "Vencimientos Usuarios". El `Full.rar` que anduvo dando vueltas era una **concatenación de los dos** → daba "0 filtrados / sin nombre".

### Encoding (server.js `decodeCsv`)
Se lee latin-1 (si al decodificar utf8 aparece el carácter de reemplazo `�`, se usa latin1). Antes leía utf8 fijo y corrompía ñ/tildes en nombres.

### Filtro: quedarse solo con lo NUESTRO (`procesar.js`)
Una oblea es nuestra si es **taller nuestro Y comisionista nuestro** (las dos, con AND). CLAVE: un taller propio (ej. IRT0550) también hace obleas de comisionistas EXTERNOS, por eso el taller solo no alcanza.

- **Talleres propios** (`TALLERES_PROPIOS`): `IRT0550` (Nova Gral Paz), `HIT0797` (Nova R20), `QUT0856` (Grupo P5). **CORREGIDO 2026-08-18 (OB-8)** — antes decía `QUT0867` = Grupo P5 y estaba al revés. Verificado contra la razón social que ENARGAS trae en `nova_operaciones.datos_raw->>'TRAZSOC'` (DB `enargas_data`): `QUT0856` = **GRUPO P5 S.R.L.** (propio, opera desde 12/2025), `QUT0867` = **CAR EQUIP S.A.S.** (ajeno, misma empresa que `HIT0714`), `QUT0865` = sin razón social, 714 ops en Cruz del Eje 2023-09/2024-11 (ajeno). La nota vieja del "Full.rar mal armado" tenía razón sobre `QUT0865` pero no sobre `QUT0856`: cuando se escribió, Grupo P5 todavía no operaba, por eso no aparecía en los exports. **Corroboración independiente:** los comisionistas propios de Grupo P5 son `856@2/4/11` — el comisionista se prefija con el número del taller, y no existe ningún `867@*`.
- **Comisionistas propios** (`COMISIONISTAS_PROPIOS`, lista fija): `550@5/6/15` (PROMOTP), `797@2/3/4/5` (Nova R20 interno), `856@2/4/11` (Agencia/Mostrador/PROMO TP). **+ SUBTAL/GNCOBS3 vacío = trabajo directo = nuestro.**
- **Regla de dígitos NO sirve** (Bronte `550@43` es externo con 2 díg.) → por eso lista explícita.
- `getComisionista(r)` = `GNCOBS3 || SUBTAL` → funciona con ambos formatos.
- **Visibilidad anti-error:** `procesarRows` devuelve `excluidosComisionista` (total + desglose por código) y el frontend muestra un banner con los excluidos, para cazar un código nuestro que quedó afuera del allowlist.

### Split obleas / PH
`tipoGestion(r)`: `UCODGEST === 'X'` → **PH** (Revisión CRPC); el resto → **oblea** (REV. ANUAL). NO hace falta el detalle de cilindros (ES-12) para esto. Se generan **dos tandas** de archivos: `obleas-*` y `ph-*`.

### Export limpio para ManyChat (`dividirArchivos`)
- Columnas: **`nombre;marca;modelo;patente;telefono`** (UAPEYNOM, UMARCA, UMODELO, UDOMINIO, WhatsApp 549…).
- **Solo teléfonos válidos (OK)** entran. Los "0"/"11111"/basura NO se exportan. Los LEVE (arreglables a mano) quedan en la app para editar.
- **N teléfonos por archivo** configurable en la UI (`porArchivo`, default 50) — es N **válidos**, no N registros.
- Split por período de vencimiento + por N. Nombres `obleas-{MM-YYYY}-V{n}.csv`.
- ZIP con carpetas `obleas/` y `ph/`.

### Carga multi-archivo
`/api/procesar` acepta varios CSV juntos (`upload.array('archivos')`) → se concatenan en un período. (El reporte Vencimientos Usuarios ya viene combinado, pero se soporta subir varios.)

### Métricas
- **Por Vendedor** (`GNCOBS1`: VDIAZ, FLUNA, BGUZMAN…) — presente en el formato 66-col. En el 144-col no existe → saldría "Sin vendedor".
- Gráfico de taller muestra código + nombre (`TALLER_NOMBRES`).
- Teléfonos `000000`/ceros → clasificados como SIN_TELEFONO (no "repetido obvio").
- Sugerencia de teléfono (Opción A): solo se sugiere si es OK; LEVE/RECHAZAR → vacía (no inventar códigos de área).

### Import directo desde InfoSys — todavía NO alcanza (2026-07-17)
El feed `nova_operaciones` NO trae `GNCOBS1` (vendedor, 0 filas) y el comisionista (`SUBTAL`) viene incompleto (IRT0550 52%, QUT0867 ~0% — ojo, `QUT0867` se creía taller propio en esa fecha y es de Car Equip; ver OB-8). **Encargo ES-16** a Enargas Scrap: que el feed replique el reporte "Vencimientos Usuarios" 1:1. Cuando esté, el import directo funciona sin tocar la app (ya lee esos campos).

---

## Periodos guardados

Los archivos `.json` en `data/periodos/` se nombran `MM-YYYY.json`.

---

## Variables de entorno (.env en S18)

```
APP_CLAVE=<ver en S18>
GOOGLE_CLIENT_ID=<Google Cloud Console>
GOOGLE_CLIENT_SECRET=<Google Cloud Console>
GOOGLE_REDIRECT_URI=https://obleas.novagnc.com.ar/auth/google/callback
PGHOST=168.231.93.65
PGPORT=5435
PGDATABASE=cdp_nova
PGUSER=gnc_admin
PGPASSWORD=<ver en MAPA-SISTEMA.md o en S18 .env>
# Agregadas 2026-05-22 (tienen fallback hardcodeado, no son obligatorias):
DALEGAS_API_URL=https://api.dalegas.com.ar
DALEGAS_API_KEY=AppNovaSecret2026
COMUNICACIONES_HUB_URL=https://n8n.srv803796.hstgr.cloud/webhook/comunicaciones
```

---

## Importación desde base (InfoSys) — agregado 2026-07-13

Alternativa al upload de CSV: traer los registros directo de `nova_operaciones` (feed de InfoSys en `enargas_data`), eligiendo mes de vencimiento. **El upload de CSV sigue activo** como respaldo.

### Fuente de datos
- Tabla: `nova_operaciones` (DB `enargas_data`, misma conexión `poolEnargas`). **Es de lectura** — la tabla y su sync los mantiene el proyecto **Enargas Scrap**, no sistema-obleas.
- **OJO (2026-07-29):** `nova_operaciones` NO es solo de Nova — es un dump amplio de ENARGAS con **~100+ talleres** (competencia incluida). Por eso el import SIEMPRE acota a los talleres Nova en el SQL (`taller_codigo = ANY(NOVA_TALLERES)`).
- Cada fila trae `datos_raw` (jsonb) con los mismos campos U* de la vieja megatabla CSV (UDOMINIO, UOBLEANEW, UTELEFONO, UAPEYNOM, TCODTAL, UFECVENHAB, etc.).
- Dos fuentes con **dos formatos de fecha** en `UFECVENHAB`: `infosys_sql` (ISO `YYYY-MM-DD`) y `csv` (`DD/MM/YYYY`). El SQL normaliza ambos (`SQL_VENC_EXPR` en server.js).
- Talleres Nova: `NOVA_TALLERES = [...TALLERES_PROPIOS]` (**fuente única** importada de `procesar.js` = `IRT0550, HIT0797, QUT0856`). Historial de esta lista: el 2026-07-29 se la sacó de estar hardcodeada acá y se la pasó a `procesar.js` (bien), pero con el contenido equivocado (`QUT0867` en vez de `QUT0856`); el **2026-08-18 (OB-8)** se corrigió el contenido contra la razón social de ENARGAS. Ver el detalle en la sección "Filtro: quedarse solo con lo NUESTRO".
- **El feed ya trae la capa comercial (2026-07-29):** `GNCOBS1` (vendedor), `GNCOBS3` (código de comisionista) y `subtaller_nombre` (nombre del comisionista: MANSILLA, MOSTRADOR, etc.) vienen poblados en los meses recientes. El viejo comentario "GNCOBS3 siempre vacío / GNCOBS1 0 filas" quedó obsoleto — el encargo **ES-16 está sustancialmente cumplido**.

### Endpoints (server.js)
```
GET /api/base/periodos                          → meses disponibles + conteo {total, obleas, ph}
GET /api/base/importar?mes=YYYY-MM&tipo=todos|oblea|ph
    → mismo shape que /api/procesar (registros, métricas, archivos, excluidosComisionista)
    → dedup DISTINCT ON (patente) por fecha_operacion desc; procesa con procesarRows(rows)
```
**Original vs Filtrado (CORREGIDO 2026-07-29):** el import llama `procesarRows(rows)` **SIN** `yaFiltrado`. Así `procesarRows` aplica `filtrar()` y quedan dos vistas distintas:
- **Original** = todas las filas de talleres Nova (todos los comisionistas). Es la vista cruda.
- **Filtrado** = solo comisionista propio (o venta directa sin comisionista). Es lo que va al broadcast, igual que el CSV.
- Antes pasaba `{yaFiltrado:true}` → Original == Filtrado (bug: "Revisar Teléfonos" y "Ranking" mostraban todo sin filtrar). Los excluidos (taller nuestro + comisionista externo) se devuelven en `excluidosComisionista` y salen en el banner de la pestaña Archivos.

`procesar.js` expone `procesarRows(rows, opts)` (núcleo compartido CSV/base) y `normalizarLocalidad`. `mapRegistro()` en server.js da forma al registro para ambos paths (incluye `COMISIONISTA_NOMBRE` = subtaller_nombre, para mostrar el nombre del comisionista en vez del código en gráficos/banner).

### Oblea vs PH — flag MOSTRAR_PH
- Clasificación: `UCODGEST='X'` (Revisión CRPC) = **PH**; el resto = **oblea**.
- **Importante:** InfoSys **todavía NO manda el detalle real de cilindros/PH** (CUPH*/CIL*/REG* vienen en 0). Ver encargo **ES-12** en Enargas Scrap (bloqueado esperando a Sebastián Fanitini).
- Por eso el frontend tiene `const MOSTRAR_PH = false` en `public/index.html`: hoy trae **todo como obleas** (oculta el selector de tipo y la columna PH). El backend igual calcula `_tipoGestion` (queda listo).
- **Cuando ES-12 se complete** (InfoSys manda CUPH*) → poner `MOSTRAR_PH = true` y se activa la separación obleas/PH real. Alternativa sin esperar: PH está en `historial_obleas_datos.datos->cilindros[].fecha_crpc` (scan ENARGAS).

## Export a ManyChat + clasificación oblea vs oblea+PH por contacto (OB-4 — 2026-08-13)

Primer slice del stack CEO-61 (inyectar contactos de obleas a ManyChat con tags). Este proyecto produce **el dato**; la inyección por API la hace GP-37 (organizacion-gp5). Diseño rector: `agente-ceo/disenos/obleas-manychat-broadcast/DISENO.md`.

### Clasificación por contacto — `tipo_vencimiento` (3 grupos)
Al importar desde InfoSys, cada contacto se clasifica según la **PH más cercana** (el mínimo entre sus cilindros — una patente puede tener 3+), medida contra el vencimiento de la oblea (regla de Ariel 2026-08-14):
- `ph_urgente` — PH vence **dentro de los próximos 6 meses** (incluye ya vencida). Aviso más fuerte ($$$).
- `ph` — PH vence **entre el mes 7 y el 12**.
- `solo_oblea` — PH vence **después del mes 12** (solo se avisa la oblea).
- `ph_desconocido` — falta el dato del cilindro (ej. período cargado por **CSV**, que no trae cilindros; solo el import InfoSys los trae).
- **Referencia agosto 2026** (audiencia filtrada 464): `ph_urgente` 162 · `ph` 57 · `solo_oblea` 245. Original (1285): 389 / 175 / 721.

**Cálculo del PH (server.js):**
- Los cilindros vienen en `nova_operaciones.datos_raw._cilindros[]` (poblados desde el backfill del ES-19, ~99%). Cada uno trae `CUPHANO` (año 2 díg del último PH) y `CUPHMES` (mes).
- **PH vence = último PH + 5 años** (estándar ENARGAS para cilindros GNC, confirmado con Ariel). Se toma el **más próximo** entre todos los cilindros del vehículo.
- Helpers: `phVenceDe(cilindros)` (mínimo entre cilindros) y `clasificarVencimiento(obleaVenc, phVence)`. El campo se calcula en el mapeo de `/api/base/importar` y viaja como `_phVence` (ISO) + `_tipoVencimiento` en cada registro (via `mapRegistro`), así queda guardado en el período JSON.

### Endpoint de consumo (lo lee GP-37/n8n)
```
GET /api/export/manychat?periodo=<id>     (ej. periodo=8-2026)
Header: X-API-Key: <MANYCHAT_EXPORT_API_KEY>
```
- Auth por **API key** (no sesión) — chequeada en `authMiddleware` para paths `/api/export/*`. La key está en `MANYCHAT_EXPORT_API_KEY` (env, con fallback en código como dalegas). **Overridear en `.env` de S18 si se quiere.**
- Lee un período **GUARDADO** (tiene que importarse desde InfoSys y guardarse 💾). Devuelve la **audiencia de broadcast** (comisionista propio) con **solo teléfonos WhatsApp válidos** (`telWhatsappValido`, prioriza la corrección manual de Yhonny `UTELEFONO_FINAL`).
- Respuesta: `{ ok, periodo, periodo_label, generado_en, total, resumen_tipo_vencimiento, contactos: [{ nombre, telefono(549…), patente, marca, modelo, ano, tipo_vencimiento, taller, taller_nombre, periodo }] }`.
- **`nombre`** = `UAPEYNOM` tal cual (InfoSys lo trae como "APELLIDO NOMBRE" en un solo campo; no se separa apellido para no romper apellidos compuestos). Si GP-37 necesita el split, lo hace del lado del consumidor.

### Contrato para GP-37
GP-37 llama al endpoint con la key, mapea `tipo_vencimiento` → tags de ManyChat (`Nova Obleas` / `Nova PH`), `periodo` → tag de mes, `taller` → `Taller Sorvi`/`Taller GP5`. sistema-obleas **no** decide tags — solo entrega el dato.

## Inyectar a ManyChat desde la app — botón de Yhonny (OB-5 — 2026-08-14)

Paso 2/2 del stack "Inyeccion Obleas". Yhonny **define la tanda, ve el preview y dispara la inyección**
sin CLI, desde el tab **"Descargar Archivos"** (card `🚀 Inyectar a ManyChat`, debajo del ZIP). La app
**no reimplementa nada de ManyChat**: es un **proxy** al servicio GP-37 (`organizacion-gp5`), que es el
dueño de la lógica (upsert por WhatsApp + tags + reparto V\* + opt-out). Aislamiento respetado.

### Flujo en la UI (`public/index.html`)
1. Input **tamaño de tanda (V\*)** (default 100).
2. **Preview** (`previewInyeccion`) → dry-run → `renderInyeccionPlan` muestra el reparto por grupo con
   las V\*, válidos/inválidos, aviso si supera V10, etiquetas comunes. NO toca ManyChat.
3. **Inyectar a ManyChat** (`ejecutarInyeccion`, aparece tras el preview) → confirm → corrida **real**
   → barra de progreso con polling cada 5 s (`pollInyeccionEstado`) → **resumen** (creados /
   actualizados / opt-out / con error).
4. **Semáforo de salud** del servicio en el header de la card (`chequearServicioInyeccion`, al abrir el tab).
- **Exige período GUARDADO** (💾): el servicio lee la audiencia vía el endpoint OB-4, que solo devuelve
  períodos guardados. CSV (sin cilindros) → todo `ph_desconocido` = Nova Obleas (igual funciona).

### Proxy en server.js (la X-API-Key nunca va al browser)
```
GET  /api/inyeccion/health                          → { ok, configurado }  (semáforo)
POST /api/inyeccion/preview   { periodo, tanda_size } → GP-37 POST /inyectar modo dry-run → { plan }
POST /api/inyeccion/ejecutar  { periodo, tanda_size } → GP-37 POST /inyectar modo real     → { jobId }
GET  /api/inyeccion/estado/:jobId                    → GP-37 GET /estado/:jobId
```
Protegidos por sesión (Yhonny logueada). Fallo de red → 502 con mensaje claro; sin key → 503.

### Config (S18)
- `INYECCION_API_KEY` — **solo por env** (regla de credenciales, sin fallback en código). En el `.env`
  de S18 **y** en el bloque `environment:` del `docker-compose.yml` de obleas (la lista es explícita).
  Coincide con la key del servicio GP-37 (registrada en `panel.api_keys`, PN-76).
- `INYECCION_SERVICE_URL` — default `http://192.168.0.18:3120` (ambos containers en S18; GP-37 publica 3120).

### Contrato del servicio GP-37 (S18:3120, contenedor propio de organizacion-gp5)
- dry-run → `{ ok, plan: { periodoLabel, tandaSize, totalExport, validos, invalidos, porGrupo:[{grupo,total,v}], superanV10, sinTagTaller, tagsComunes } }`
- real → 202 `{ ok, accepted, jobId, estadoUrl }` · estado → `{ ok, estado:'corriendo'|'hecho'|'error', progreso:{i,n}, resumen:{total,creados,actualizados,optout,conError} }`

**Dependencia:** el end-to-end real requiere que el **contenedor GP-37 esté levantado** en S18:3120
(deploy = trabajo de GP-37, `en_curso` en organizacion-gp5 al 2026-08-14). Si no está, la UI muestra
🔴 "Servicio no responde" y no rompe. Cuando GP-37 levante el 3120, funciona sin tocar obleas.

## Calidad de Contactos (OB-3 — 2026-08-14)

Pantalla para auditar la calidad del teléfono que carga un taller (o un comisionista bajo un taller nuestro), y bajar un informe PDF para pedirle que corrija. Encargo `encargos/hechos/…-OB-3-…-DONE.md`.

- **UI:** `public/calidad-contactos.html` (link en la navbar de index.html). Scope taller/comisionista + **buscador** + año → Generar → render del documento oficial → Descargar PDF.
- **Buscador (combo):** en vez de tipear el código a mano, se busca por código o nombre. Taller = **multi-select con chips** (una entidad puede tener varios códigos, ej. Car Equip = QUT0867 + HIT0714 → `id=QUT0867,HIT0714`); comisionista = single. Con fallback a texto libre + Enter si el listado no carga.
- **Proxy:** `GET /api/calidad-contactos?scope=taller|comisionista&id=&anio=` en server.js → reenvía a `api.dalegas.com.ar/api/calidad_contactos` (**fuente única del cálculo = Enargas Scrap**; NO recalcular acá). API key en el server (`CALIDAD_API_KEY`, fallback a `DALEGAS_API_KEY`), nunca en el browser.
- **Opciones del buscador:** `GET /api/calidad-contactos/opciones?scope=taller|comisionista` → lista {id, nombre, n} desde `nova_operaciones` (solo lectura). Taller = todos los talleres (con flag `es_nova`); comisionista = solo los que operan bajo talleres Nova (`NOVA_TALLERES`). Es enumeración de entidades, NO el cálculo de calidad.
- **PDF:** html2pdf.js (cdnjs). Filename incluye `ref_interna`: comisionista → `informe-contactos-{anio}-{ref_interna}.pdf`, taller → `…-taller-{codigos}.pdf`.
- **Regla de discreción (CRÍTICA):** en el reporte por comisionista el **cuerpo solo muestra `taller_nombre`**; el código del comisionista (`ref_interna`) va SOLO en el nombre del archivo, nunca impreso. ENARGAS no distingue que esas operaciones son de un taller tercero bajo el nuestro; el documento no puede delatarlo. El correlativo `Informe N.º` es neutro (fecha), no revela nada.
- **Envío al comisionista:** NO automatizado (no hay canal para mandar un PDF a un comisionista externo). Se baja el PDF y se manda a mano. Idea `OB-6` para definir canal.
- El CSS del documento oficial está scopeado bajo `#docRender .doc` para no chocar con el chrome del app.

## Pendientes conocidos

1. **Import directo desde InfoSys** — ✅ **funcionando (2026-07-29).** El feed ya trae vendedor (`GNCOBS1`), comisionista (`GNCOBS3`) y nombre (`subtaller_nombre`), así que el import filtra y muestra igual que el CSV. ES-16 sustancialmente cumplido. Verificar con Ariel si se puede cerrar ES-16 del lado de Enargas Scrap y dejar de subir CSV a mano.
2. **Reporte Mayo 2026** — quedó pendiente el paso manual de Yhonny (Ver guardados → Reintentar → 💾). Ver sección dalegas.
3. **Guía de uso para Yhonny** — documento operativo paso a paso del flujo nuevo (subir Vencimientos Usuarios → revisar teléfonos → descargar obleas/PH → ManyChat).
4. **Importación automática a ManyChat** — ✅ **resuelto en OB-5** (botón "🚀 Inyectar a ManyChat" en el tab Descargar Archivos, ver sección OB-5). El ZIP queda como respaldo.
5. **Sincronizar estructura local ↔ S18** — evaluar deploy script o GitHub Action (hoy es scp + rebuild manual).
6. **`verificar.js` legacy** — no hardcodea talleres: usa `config.talleresPropios` (default del endpoint `/api/config` en server.js, hoy `IRT0550, HIT0797, QUT0856`). Si hay un `data/config.json` guardado en S18 con la lista vieja, **ese archivo pisa el default** — revisarlo tras un cambio de talleres.

### Estado al cierre 2026-08-18 (OB-8) — Corregido el taller propio mal listado

**Qué estaba mal:** `TALLERES_PROPIOS` listaba `QUT0867` como Grupo P5. Es al revés: `QUT0867` es **CAR EQUIP S.A.S.** (un tercero) y Grupo P5 es **`QUT0856`**. Consecuencia: los listados de obleas y PH "por taller propio" metían adentro 7.221 operaciones de otra empresa y **perdían el taller de Grupo P5 completo**. Solo afecta a 2026 en adelante — `QUT0856` empezó a operar en 12/2025, y ese es justamente el motivo del error: cuando se armó la lista (2026-07), Grupo P5 no aparecía en ningún export porque todavía no existía.

**Cómo se verificó** (query contra `enargas_data`, reconfirmada al ejecutar el encargo):

| Código | Razón social (`datos_raw->>'TRAZSOC'`) | Ops | Rango | ¿Nuestro? |
|---|---|---|---|---|
| `IRT0550` | SORVICOR SRL | 63.259 | 2016-01 → hoy | ✅ Nova Gral Paz |
| `HIT0797` | NOVA GNC SRL | 29.712 | 2019-07 → 2026-06 | ✅ Nova R20 |
| `QUT0856` | **GRUPO P5 S.R.L.** | 3.555 | 2025-12 → hoy | ✅ Grupo P5 |
| `QUT0867` | **CAR EQUIP S.A.S.** | 7.221 | 2020-04 → hoy | ❌ ajeno |
| `QUT0865` | *(sin razón social)* | 714 | 2023-09 → 2024-11 | ❌ ajeno |
| `HIT0714` | CAR EQUIP S.A.S. | 6.510 | 2017-10 → 2025-12 | ❌ ajeno (misma empresa que QUT0867) |

**Corroboración independiente:** `COMISIONISTAS_PROPIOS` ya tenía `856@2/4/11` etiquetados como Grupo P5. El comisionista se prefija con el número del taller, y no existe ningún `867@*`. O sea que la app venía filtrando bien los comisionistas de P5 pero descartando sus obleas por el taller.

**Archivos tocados:**
- `lib/procesar.js` — `TALLERES_PROPIOS` = `{IRT0550, HIT0797, QUT0856}`, con el detalle de cada código en el comentario.
- `server.js` — `TALLER_NOMBRES` (`QUT0856` → 'Grupo P5'), default de `/api/config` `talleresPropios` (agregado `QUT0856`), comentario de `NOVA_TALLERES`. `NOVA_TALLERES` en sí no se tocó: ya importaba de `procesar.js`, así que se corrigió solo.
- `public/index.html` — `TALLER_NOMBRES` y el fallback de `toggleFiltroDetalle` (decía `QUT0865`).
- `README.md`, este archivo — tablas de códigos y notas históricas.

**⚠️ Pendiente de deploy:** el endpoint `/api/config` solo devuelve el default cuando **no existe** `data/config.json` en S18. Si Ariel guardó configuración alguna vez desde la UI, ese archivo tiene la lista vieja y **pisa el default corregido**. Al deployar hay que mirarlo:
```bash
ssh akeneo@100.72.42.104 "cat /home/akeneo/sistema-obleas-app/data/config.json"
```
Si trae `talleresPropios` con `QUT0867`/`QUT0865`, corregirlo ahí (o desde Configuración en la UI). Afecta a `verificar.js`, que lee talleres propios de la config, no de `TALLERES_PROPIOS`.

**Hallazgo al revisar con Ariel — los códigos de taller CAMBIAN (2026-08-18):** un taller que se da de baja y se reactiva suele volver con otro `TCODTAL`. Pasó con el nuestro: Ruta 20 dejó de operar como `HIT0797` (NOVA GNC SRL) y pasó a `QUT0856` (GRUPO P5 S.R.L.) en **diciembre 2025**, en un relevo limpio:

| Mes | HIT0797 | QUT0856 | IRT0550 |
|---|---|---|---|
| 2025-11 | 414 | 0 | 757 |
| **2025-12** | **101** | **393** | 922 |
| 2026-01 | 1 | 424 | 801 |
| 2026-07 | 0 | 505 | 1.701 |

No es un taller nuevo: es el mismo local con código y sociedad nuevos. Por eso el error de la lista pegaba tan fuerte en 2026 — `HIT0797` aporta **0** operaciones y todo Ruta 20 vive en `QUT0856`. En lo que va de 2026 faltaban 3.162 ops propias y sobraban 1.202 ajenas.

⚠️ **Consecuencia para el diseño:** una lista fija de códigos se rompe **en silencio** cada vez que ENARGAS recodifica un taller — no falla nada, simplemente los números salen mal. `HIT0797` se deja en `TALLERES_PROPIOS` porque cubre el histórico hasta 11/2025. Si en algún momento se corrigen los números y no cierran, **lo primero a revisar es si apareció un código nuevo**:

```sql
SELECT taller_codigo, max(datos_raw->>'TRAZSOC') rs, count(*) ops, max(fecha_operacion) ultima
FROM nova_operaciones WHERE fecha_operacion >= now() - interval '3 months'
GROUP BY 1 ORDER BY 3 DESC LIMIT 20;
```

Ojo: `nova_operaciones` trae ~100 talleres (todos los que operan con nuestros PECs 3145/3286), no solo los de Nova. El código de taller nunca alcanzó por sí solo para decir "esto es nuestro" — hay que mirar la razón social. Ejemplo verificado con Ariel: la patente `FLI070` figura en 2024 con `QUT0865` y `pec_origen=3145`; el taller era **Zambrano** (CUIT 20-11801086-9) usando nuestro PEC. En 2026 Zambrano ya tiene PEC propio, y por eso esa operación no aparece más en el feed. El feed **no trae CUIT** (`TCUIT`/`PCUIT` vacíos), así que hoy la única identificación de empresa es la razón social.

**Cómo comprobar que quedó bien:** reimportar un mes de 2026 y comparar contra la corrida anterior — el total debe **bajar** por las operaciones de Car Equip que ya no entran y **subir** por las de Grupo P5 que antes se perdían. Si un mes de 2026 no cambia en nada, quedó un hardcodeo en otro lado.

### Estado al cierre 2026-08-21 (verificación post-envío + reporte + inyección + ES-21/GP-39)
Sesión larga de mejoras (todo desplegado por scp+rebuild y commiteado). Commits: `85a1ffc`, `ad74c68`,
`284756d`, `4ca5688`, `0442d0c` (obleas) + `b198190` (inyección, del bloque anterior).

**Verificación post-envío (`renderVerifResultados` / tab Verificación):**
- **KPIs con %** del total verificado (además de la cantidad).
- **PDF de resumen** (`generarVerifPDF`, botón "Descargar PDF (resumen)"): título, total, tabla
  clasificación con %, y el gráfico. **Sin listado de clientes** (jsPDF + autoTable).
- Tabla: **columna Teléfono** (`telVerif`: prioriza `UTELEFONO_FINAL`) + **filtro por clasificación**
  (`renderVerifTabla(filtro)`, default Todos). Labels/colores/badges hoisteados a `VERIF_LABELS`/
  `VERIF_COLORS`/`VERIF_BADGES` (nivel módulo).
- **CSV** (`exportarVerifCSV`) ahora incluye **columna TELEFONO** + sanitizado de `;`/saltos.
- **Re-analizar de cero ya NO manda `force:true`.** Ahora borra el job anterior (DELETE) y corre con
  **`force:false`** → resuelve desde nuestra base (ES-21) y va a S14 solo por lo que falte. `force:true`
  salteaba la base y mandaba TODO a S14 (era la causa del "cache:0 | S14:464" que reportó Ariel).
- **"Cancelar" ahora frena el job de verdad:** proxy nuevo **`DELETE /api/lote/:jobId`** en server.js;
  `cancelarVerificacion` borra el job en dalegas (detiene S14). En modo "solo ver" NO borra (guardados).
- Diálogos de "ya existe / re-analizar" reescritos, mucho más claros.

**Reporte PDF — Obleas Vencidas (`generarReportePDF` / tab Reporte):**
- **Sección "Resultados de Verificación (Renovación)"** con No Renovó + % (si hay verificación corrida).
- **Objetivo de renovaciones (carga MANUAL):** input "🎯 Objetivo de renovaciones (Nova) del mes";
  se guarda con el período (`objetivoRenovaciones` en el JSON), se resetea con cada dataset nuevo, se
  recarga al abrir un período. Vista previa + PDF muestran **Objetivo · Realidad · Desfasaje ·
  Cumplimiento**. **Realidad = `NUESTRO_PEC_NUESTRO_TALLER`** (helper `realidadRenovacionesNova`).
  **INTERINO:** los objetivos NO existen hoy en cdp_nova/panel (verificado: solo hay `presupuesto_*`/
  `cotizador_*`, que son el cotizador). Ariel definirá la fuente oficial (dijo "panel/CDP") más
  adelante → cuando exista, obleas la lee y el campo manual queda de fallback.

**Dependencias cross-proyecto resueltas esta sesión (ambas HECHAS):**
- **ES-21 (Enargas Scrap):** `dalegas /api/lote` ahora resuelve **cache-first desde `enargas_data`**
  (`nova_operaciones` = infosys al momento + `historial_obleas_datos` = scans 48h) y solo escanea S14
  en vivo por lo que falta. La respuesta suma `desde_base:{infosys,scan_db,frescura}`. La verificación
  de obleas se beneficia sin cambios (mismo formato). Verificado end-to-end (smoke test 5/8 desde base).
- **GP-39 (organizacion-gp5):** el plan del inyector expone `porGrupo[].tags` (etiquetas completas) y
  numera las **V correlativas entre grupos** (PH Urgente → PH → Obleas). `renderInyeccionPlan` ya lo
  muestra (commit `b198190`). Preview colapsa la tabla de archivos al presionarlo.

**Nota de infra:** el flujo de verificación sigue siendo obleas → dalegas (proxy `/api/lote`). Obleas
NO consulta `enargas_data` por su cuenta en la verificación — el "base-first" lo hace dalegas (ES-21).

### Estado al cierre 2026-08-14 (ajustes tab "Descargar Archivos") — commit `d311dba`
Cuatro ajustes pedidos por Ariel sobre el tab **Descargar Archivos** (todo desplegado por scp+rebuild y commiteado):
1. **BUG PH corregido (importante).** `tipoGestion(r)` ahora **prioriza `_tipoGestion`** (que sí sobrevive `mapRegistro`), con `UCODGEST` de fallback. Causa raíz: `mapRegistro` (lo que queda en `STATE.registros`) **no reexpone `UCODGEST`**; al cambiar "teléfonos por archivo", `regenerarArchivos` reenviaba esos registros a `/api/generar-archivos` → `dividirArchivos` reclasificaba TODO como oblea → **los archivos PH desaparecían y no volvían** ni bajando de nuevo el número. Probado con round-trip 50→100→50: PH se mantiene. **Si tocás `mapRegistro` o `tipoGestion`, no vuelvas a depender de `UCODGEST` en el path de regeneración.**
2. **Reorden del tab:** banner de excluidos (arriba) → card **🚀 Inyectar a ManyChat** → card **🔖 Obleas y 🧪 PH — archivos y ZIP** (abajo, respaldo manual). El banner se renderiza aparte en `#bannerExcluidos` (fuera de `#listaArchivos`) vía `renderBannerExcluidos()`.
3. **Detalle de comisionistas excluidos** ahora en `<details>` desplegable (el título queda a la vista, el desglose largo colapsado). No usé tooltip por hover: no anda en touch.
4. **Default "teléfonos por archivo" 50 → 100** (input, `STATE.porArchivo`, fallbacks del front y defaults del server/`dividirArchivos`).
- **Verificación pendiente (visual, con Ariel logueado):** importar **septiembre 2026 desde InfoSys** (tiene PH: 1.471 total / 306 PH crudos; tras dedup+filtro propio ≈ 545 filtrado / 104 PH) y confirmar que al mover 50↔100 los archivos PH se mantienen. El OAuth no lo puedo hacer headless.

### Estado al cierre 2026-08-14 (OB-5) — Inyección a ManyChat desde la app
Paso 2/2 del stack "Inyeccion Obleas". Yhonny inyecta a ManyChat desde el tab **Descargar Archivos** (tanda + preview + trigger + progreso). Ver sección **"Inyectar a ManyChat — botón de Yhonny (OB-5)"**. Todo desplegado (scp + rebuild) y commiteado (`07be6c5`, pusheado).
- **End-to-end verificado el mismo día:** GP-37 desplegó su contenedor (`inyeccion-obleas-manychat`, S18:3120, healthy) y es alcanzable desde el container de obleas. Dry-run del período `4-2026` vía el servicio → 469 válidos, reparto V1–V5. El stack quedó **operativo**.
- **Pendiente antes de la 1ª corrida real:** prueba visual con Yhonny logueada + test obligatorio con números de test (protocolo GP-37). Yo no puedo hacer el OAuth headless.
- **Decisión abierta (de Ariel, con CEO/GP-37 — no obleas):** ¿el `taller` va como **tag** o como **custom field** en ManyChat? El diseño lo marca opcional (no es eje de filtro). Obleas ya emite `taller`/`taller_nombre` igual; la materialización es de GP-37.
- **Config nueva en S18:** `INYECCION_API_KEY` (solo env, en `.env` + bloque `environment:` del `docker-compose.yml`) e `INYECCION_SERVICE_URL`. Backups `.env.bak-*` y `docker-compose.yml.bak-*` en S18.
- **Nota ecosistema (para el CEO):** el contrato de consumo obleas→servicio GP-37 podría registrarse en MAPA-SISTEMA.md (fuente única + contrato). No lo toco desde este proyecto.

### Estado al cierre 2026-08-14 (OB-7) — Login gobernado por el panel
Paso 2/2 del stack "Login Obleas" (CEO-64). El login de obleas dejó de decidirse por dominio y ahora lo autoriza el panel. Desplegado y verificado en producción (scp + rebuild).
- **Autorización por `panel.acceso_app`:** el callback de Google (`/auth/google/callback` en server.js) llama `SELECT permitido, nombre, rol FROM panel.acceso_app(email,'obleas')` por SQL directo (pool `cdp_nova` que ya existía). Entra solo si `permitido=true`. La regla (super_admin bypass + `activo` + sección `obleas`) vive en la función del panel = fuente única; obleas solo consume `permitido`, no la reimplementa.
- **Eliminado el auto-create.** El `INSERT INTO panel.usuarios ... 'operador'` se borró. La app no crea usuarios nunca más. Email fuera del padrón → rechazo, sin usuario nuevo.
- **Eliminado `APP_CLAVE`** (clave de emergencia) — se sacó el endpoint `/api/login`, la constante y la sección de clave de `login.html`. Único acceso = Google + panel. Ariel entra igual (super_admin).
- **Fail-closed:** si `panel.acceso_app`/DB no responde → rechazo (`?error=panel_no_disponible`). Se terminó el "si la DB falla, entra igual con el dominio".
- **Dominio = defensa en profundidad, no autorización.** `ALLOWED_DOMAINS` filtra gmail personal antes de consultar, pero ya no decide.
- **Mensajes de error nuevos en `login.html`:** `sin_acceso` ("tu usuario no tiene acceso a Obleas, pediselo a Ariel"), `panel_no_disponible`.
- **Verificado:** función probada con Vanesa (`obleas` → permitido), Nahir (sin sección → rechazada), Ariel (super_admin → permitido por bypass). En prod: `/login` 200, `/api/login` con clave vieja → 401 (ya no crea sesión), código `panel.acceso_app` confirmado dentro del container.
- **Cómo dar acceso de ahora en más:** tildar la sección `obleas` a la persona en el panel (`usuarios.html`). No se toca la app.
- **Loop CEO-64:** obleas es el **primer consumidor** del contrato. Falta replicar a turnos/epec/Nova Pits (sin encargo aún; se abren cuando se retome cada app). Avisar al CEO para cerrar CEO-64.
- **`.env` de S18:** `APP_CLAVE` sigue en el `.env` (quedó muerta, no se borró — regla de protección de `.env`). Se puede comentar cuando Ariel quiera.

### Estado al cierre 2026-08-14
Sesión OB-3 (reportes de calidad de contactos) + login multi-dominio. Todo desplegado y verificado en producción (scp + rebuild):
- **OB-3 ejecutado y cerrado** (`encargos/hechos/…-OB-3-…-DONE.md`). Pantalla `calidad-contactos.html` + proxy `/api/calidad-contactos` (consume `api.dalegas.com.ar/api/calidad_contactos`, fuente única Enargas Scrap) + documento oficial + PDF (html2pdf) con filename que incluye `ref_interna`. Regla de discreción verificada (el cuerpo del reporte por comisionista solo muestra el taller, nunca el código). Ver sección "Calidad de Contactos (OB-3)".
- **Buscador** de taller/comisionista por código o nombre (endpoint `/api/calidad-contactos/opciones` desde `nova_operaciones`, solo lectura). Taller = multi-select con chips (soporta entidades multi-código, ej. Car Equip QUT0867+HIT0714); comisionista = single.
- **Login multi-dominio:** `ALLOWED_DOMAIN` (string) → `ALLOWED_DOMAINS` (lista) = `['novagnc.com.ar','sorvicor.com.ar']`. Habilitado para Vanessa Urquia (`vurquia@sorvicor.com.ar`, coord_obleas). `hd=*` en el consent.
- **Login por dominio + auto-create → RESUELTO en OB-7** (ver "Estado al cierre 2026-08-14 (OB-7)" abajo). Al cierre de esta sesión (OB-3) todavía era por dominio; el encargo CEO-64 definió la convención y OB-7 la implementó.
- **Idea OB-6** (`encargos/ideas/`): definir canal para enviar el PDF de calidad al comisionista (hoy se baja y se manda a mano; no hay canal automático).
- **Deuda pre-existente (Ariel la iba a definir):** `sistema-obleas/encargos/` está gitignored en el repo padre y no pertenece al subrepo `app/` → los encargos de este proyecto quedan fuera de git (sin trazabilidad versionada). Decisión pendiente de Ariel.

### Estado al cierre 2026-07-29
Sesión de ajustes al import de InfoSys + varios fixes (todo desplegado y verificado en producción):
- **Import InfoSys: Original ≠ Filtrado.** Sacado el `yaFiltrado:true` → ahora Original = todos los talleres Nova (todos los comisionistas), Filtrado = comisionista propio. "Revisar Teléfonos" y "Ranking" leen del set filtrado. Agosto real: Original 1285 / Filtrado 464 / excluidos 821 (coincide con el 8-2026 del CSV).
- **`NOVA_TALLERES` corregido** a `[...TALLERES_PROPIOS]` (fuente única en procesar.js): `IRT0550, HIT0797, QUT0867`. Se sacaron QUT0856/0865 (ajenos), se agregó QUT0867 (Grupo P5).  ⚠️ **La parte de "fuente única" quedó bien; el contenido de la lista estaba mal y se corrigió en OB-8 (2026-08-18): el propio es QUT0856, no QUT0867.**
- **Comisionista `797@11` (PROMO TP) agregado a `COMISIONISTAS_PROPIOS`** — es de Nova, confirmado por Ariel. Ya no se excluye.
- **Nombres de comisionista en la UI.** El gráfico "por Comisionista" (Original) y el banner de excluidos muestran el nombre (`subtaller_nombre`: MANSILLA, MOSTRADOR…) en vez del código. Backend: `generarMetricas` arma `nombresComisionista` {código→nombre}; `metricasOriginal.por_comisionista` alimenta el gráfico (top-12 + "Otros").
- **Sugerencia de teléfono: se revirtió parte de la "Opción A".** Ahora `sugerirCordoba()` (normalizar.js) completa con Córdoba `351` los teléfonos a los que solo les falta el código de área (abonado de 7 díg, o celular con "15" → se saca). Los que les falta un dígito o son basura siguen sin sugerencia (no se inventa). La sugerencia es clickeable en "Revisar Teléfonos" (`usarSugerencia` copia al Número Final). Decisión con Ariel: la mayoría de clientes son de Córdoba y Yhonny revisa antes de exportar.
- **Borrar período guardado (issue #1):** botón 🗑️ por tarjeta en "Obleas Guardadas" (`eliminarPeriodo` → `DELETE /api/periodos/:id`). El endpoint ya existía; faltaba el botón.
- **Guardar tras import InfoSys (issue #2):** aviso verde con botón "💾 Guardar período" tras traer, el botón del header pulsa y el badge dice "· sin guardar". Traer de InfoSys NO persiste solo — hay que guardar (igual que el CSV). Además se limpia `STATE.verificacion` al traer datos nuevos.
- **Header:** config `talleresPropios` corregida a `IRT0550, HIT0797, QUT0867` (mostraba QUT0856).  ⚠️ **Revertido en OB-8 (2026-08-18): el valor correcto era el original, QUT0856.**
- **Sin cambios de infra.** Deploy por scp + rebuild (backups en `S18:.../_backup_deploy/`). **Cambios NO commiteados a git al momento de deployar** (el commit es este cierre).

### Estado al cierre 2026-07-17
- Formato "Vencimientos Usuarios" (66-col) soportado y probado. Filtro talleres+comisionistas, split obleas/PH, export limpio ManyChat, multi-archivo, encoding latin-1, por-vendedor, sugerencia Opción A — **todo desplegado**.
- Incidente Mayo/dalegas: escape-hatch + reintentar con cache (force:false) desplegados; **ES-15** (bug backend jobs trabados) dejado a Enargas Scrap.
- **ES-16** dejado a Enargas Scrap (feed replique el reporte).
- Deploy protocol corregido (SIEMPRE rebuild, nunca solo restart).

---

## Comandos útiles de diagnóstico

```bash
# Ver logs del container
ssh akeneo@100.72.42.104 "docker logs sistema-obleas --tail 50"

# Ver períodos guardados
ssh akeneo@100.72.42.104 "ls /home/akeneo/sistema-obleas-app/data/periodos/"

# Consultar estado de un job de lote
curl -s -H "X-API-Key: AppNovaSecret2026" "https://api.dalegas.com.ar/api/lote/obleas-abril-2026" | python3 -c "
import json,sys; d=json.load(sys.stdin)
r=d.get('resultados',[])
from collections import Counter
print('status:', d.get('status'), '| total:', len(r))
print('por status:', dict(Counter(x.get('status') for x in r)))
"

# Estado del container
ssh akeneo@100.72.42.104 "docker ps | grep obleas"

# Test endpoint
curl -s -o /dev/null -w "%{http_code}" https://obleas.novagnc.com.ar/login
```
