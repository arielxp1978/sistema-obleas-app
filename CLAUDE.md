# sistema-obleas — Instrucciones para Claude

## Qué es esto

Procesador de CSVs de obleas GNC exportados de ENARGAS. Clasifica vehículos según si renovaron en Nova (GP5/Sorvicor) o no. Deployado en producción.

**URL pública:** https://obleas.novagnc.com.ar  
**GitHub:** arielxp1978/sistema-obleas-app  
**Acceso:** Login Google @novagnc.com.ar (ydiaz, arielpalomeque)

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

- **Talleres propios** (`TALLERES_PROPIOS`): `IRT0550` (Nova Gral Paz), `HIT0797` (Nova R20), `QUT0867` (Grupo P5). Confirmado con Ariel sobre exports reales. `QUT0856/0865` eran del Full.rar mal armado.
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
El feed `nova_operaciones` NO trae `GNCOBS1` (vendedor, 0 filas) y el comisionista (`SUBTAL`) viene incompleto (IRT0550 52%, QUT0867 ~0%). **Encargo ES-16** a Enargas Scrap: que el feed replique el reporte "Vencimientos Usuarios" 1:1. Cuando esté, el import directo funciona sin tocar la app (ya lee esos campos).

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
- Cada fila trae `datos_raw` (jsonb) con los mismos campos U* de la vieja megatabla CSV (UDOMINIO, UOBLEANEW, UTELEFONO, UAPEYNOM, TCODTAL, UFECVENHAB, etc.).
- Dos fuentes con **dos formatos de fecha** en `UFECVENHAB`: `infosys_sql` (ISO `YYYY-MM-DD`) y `csv` (`DD/MM/YYYY`). El SQL normaliza ambos (`SQL_VENC_EXPR` en server.js).
- Talleres Nova: `NOVA_TALLERES = ['HIT0797','IRT0550','QUT0856','QUT0865']`. GNCOBS3 siempre vacío en esta tabla.

### Endpoints (server.js)
```
GET /api/base/periodos                          → meses disponibles + conteo {total, obleas, ph}
GET /api/base/importar?mes=YYYY-MM&tipo=todos|oblea|ph
    → mismo shape que /api/procesar (registros, métricas, archivos)
    → dedup DISTINCT ON (patente) por fecha_operacion desc; procesa con procesarRows(rows,{yaFiltrado:true})
```
`procesar.js` expone `procesarRows(rows, opts)` (núcleo compartido CSV/base) y `normalizarLocalidad`. `mapRegistro()` en server.js da forma al registro para ambos paths.

### Oblea vs PH — flag MOSTRAR_PH
- Clasificación: `UCODGEST='X'` (Revisión CRPC) = **PH**; el resto = **oblea**.
- **Importante:** InfoSys **todavía NO manda el detalle real de cilindros/PH** (CUPH*/CIL*/REG* vienen en 0). Ver encargo **ES-12** en Enargas Scrap (bloqueado esperando a Sebastián Fanitini).
- Por eso el frontend tiene `const MOSTRAR_PH = false` en `public/index.html`: hoy trae **todo como obleas** (oculta el selector de tipo y la columna PH). El backend igual calcula `_tipoGestion` (queda listo).
- **Cuando ES-12 se complete** (InfoSys manda CUPH*) → poner `MOSTRAR_PH = true` y se activa la separación obleas/PH real. Alternativa sin esperar: PH está en `historial_obleas_datos.datos->cilindros[].fecha_crpc` (scan ENARGAS).

## Pendientes conocidos

1. **Import directo desde InfoSys** — bloqueado por **encargo ES-16** (Enargas Scrap): que `nova_operaciones` replique el reporte "Vencimientos Usuarios" (falta `GNCOBS1` vendedor + `GNCOBS3`/comisionista completo). Cuando esté, se puede dejar de subir el CSV a mano.
2. **Reporte Mayo 2026** — quedó pendiente el paso manual de Yhonny (Ver guardados → Reintentar → 💾). Ver sección dalegas.
3. **Guía de uso para Yhonny** — documento operativo paso a paso del flujo nuevo (subir Vencimientos Usuarios → revisar teléfonos → descargar obleas/PH → ManyChat).
4. **Importación automática a ManyChat** — hoy Yhonny descarga el ZIP y hace el broadcast a mano.
5. **Sincronizar estructura local ↔ S18** — evaluar deploy script o GitHub Action (hoy es scp + rebuild manual).
6. **`verificar.js` legacy** — talleres desactualizados (IRT0550/HIT0797). Si se reactiva ese modo, alinear con `TALLERES_PROPIOS`.

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
