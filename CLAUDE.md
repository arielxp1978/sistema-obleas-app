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

**S18 NO puede hacer git pull desde GitHub (timeout). Usar siempre SCP:**
```bash
# Cambios en server.js:
scp "/Users/arielpalomeque/Documents/App Creadas/sistema-obleas/app/server.js" \
    akeneo@100.72.42.104:/home/akeneo/sistema-obleas-app/server.js

# Cambios solo en index.html (no requiere rebuild, solo restart):
scp "/Users/arielpalomeque/Documents/App Creadas/sistema-obleas/app/public/index.html" \
    akeneo@100.72.42.104:/home/akeneo/sistema-obleas-app/public/index.html
ssh akeneo@100.72.42.104 "cd /home/akeneo/sistema-obleas-app && docker compose restart obleas"

# Cambios en server.js u otros archivos (requiere rebuild):
ssh akeneo@100.72.42.104 "cd /home/akeneo/sistema-obleas-app && docker compose down && docker compose up -d --build"
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

## Filtro del CSV (procesar.js)

Solo se procesan registros donde:
- `TCODTAL = HIT0797` (Nova GNC) — cualquier `GNCOBS3`
- `TCODTAL = IRT0550` (Sorvicor) — solo si `GNCOBS3` está vacío
- `TCODTAL = QUT0865` — taller externo asociado a Nova

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

## Pendientes conocidos

1. **QUT0856 en talleresPropios de verificar.js** — el archivo `lib/verificar.js` (modo legacy) solo tiene IRT0550 y HIT0797. Si se vuelve a usar ese modo, agregar QUT0856.
2. **Guía de uso para Yhonny** — documento operativo paso a paso
3. **Importar datos desde enargas_data** — mostrar meses disponibles para seleccionar en vez de subir CSV manual
4. **Importación automática a ManyChat** — post-limpieza de teléfonos, Yhonny solo hace el broadcast
5. **Sincronizar estructura local ↔ S18** — evaluar unificar con deploy script o action de GitHub

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
