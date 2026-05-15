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

**Opción A — GitHub (preferida cuando hay conectividad):**
```bash
# 1. Editar archivos localmente en app/
# 2. Commit y push desde app/
cd "/Users/arielpalomeque/Documents/App Creadas/sistema-obleas/app"
git add <archivo>
git commit -m "descripción"
git push

# 3. En S18: pull y rebuild
ssh akeneo@100.72.42.104 "cd /home/akeneo/sistema-obleas-app && git pull && docker compose down && docker compose up -d --build"
```

**Opción B — SCP directo (cuando GitHub no tiene conectividad desde S18):**
```bash
# Los archivos locales están en app/ pero en S18 van sin esa carpeta
scp "/Users/arielpalomeque/Documents/App Creadas/sistema-obleas/app/lib/verificar.js" \
    akeneo@100.72.42.104:/home/akeneo/sistema-obleas-app/lib/verificar.js

scp "/Users/arielpalomeque/Documents/App Creadas/sistema-obleas/app/public/index.html" \
    akeneo@100.72.42.104:/home/akeneo/sistema-obleas-app/public/index.html

# Luego rebuild
ssh akeneo@100.72.42.104 "cd /home/akeneo/sistema-obleas-app && docker compose down && docker compose up -d --build"
```

**Después de cada rebuild — reconectar el tunnel:**
El Cloudflare Tunnel corre en un container separado (`cloudflare-tunnel`). Al recrear la red Docker hay que verificar que sigue conectado:
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
| PostgreSQL | cdp_nova en VPS Hostinger, tabla `panel.usuarios` para autorización |
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

## Lógica de clasificación de obleas (verificar.js)

El CSV de ENARGAS contiene obleas con `UFECVENHAB` = fecha de vencimiento del período analizado.

Para cada vehículo se consulta la API (`consultas-gnc.arielxp.workers.dev`) y se clasifica:

| Resultado | Condición |
|---|---|
| **Nuestro PEC + Nuestro Taller** | `fechaVencimiento` nueva oblea > `UFECVENHAB` Y PEC = 3145/3286 Y Taller = IRT0550/HIT0797 |
| **Nuestro PEC + Taller Externo** | Igual pero taller no es de Nova |
| **Otro PEC** | Renovó pero en PEC externo |
| **No Renovó** | `fechaVencimiento` <= `UFECVENHAB` (no hay operación posterior al vencimiento) |

**IMPORTANTE:** La comparación usa `fechaVencimiento` de la nueva oblea (no `fechaHabilitacion`).  
Así se detectan renovaciones anticipadas (ej: oblea vence en abril, el cliente vino en marzo → nueva oblea vence en 2027 > abril → renovó).  
Esto se corrigió el 2026-05-15. Si se usa `fechaHabilitacion`, las renovaciones anticipadas aparecen como "No Renovó" por error.

### PECs y Talleres de Nova

| Código | Razón Social | Tipo |
|---|---|---|
| `3145` | SORVICOR S.R.L. | PEC |
| `3286` | GRUPO P5 S.R.L. | PEC |
| `IRT0550` | SORVICOR S.R.L. | Taller |
| `HIT0797` | NOVA GNC S.R.L. | Taller |

---

## Filtro del CSV (procesar.js)

Solo se procesan registros donde:
- `TCODTAL = HIT0797` (Nova GNC) — cualquier `GNCOBS3`
- `TCODTAL = IRT0550` (Sorvicor) — solo si `GNCOBS3` está vacío
- `TCODTAL = QUT0865` — taller externo asociado a Nova

---

## Periodos guardados

Los archivos `.json` en `data/periodos/` se nombran `MM-YYYY.json` según el mes del campo `UFECVENHAB` del CSV.

Estructura del JSON:
```json
{
  "periodoId": "4-2026",
  "registros": [...],
  "verificacion": {
    "resumen": { "NO_RENOVO": 12, "NUESTRO_PEC_NUESTRO_TALLER": 5 },
    "detalle": [...]
  },
  "guardadoEn": "...",
  "version": 1
}
```

La verificación solo se guarda si Yhonny hace click en 💾 después de correrla.

---

## Variables de entorno (.env en S18)

```
APP_CLAVE=<ver en S18: cat /home/akeneo/sistema-obleas-app/.env>
GOOGLE_CLIENT_ID=<Google Cloud Console — proyecto Nova GNC>
GOOGLE_CLIENT_SECRET=<Google Cloud Console — proyecto Nova GNC>
GOOGLE_REDIRECT_URI=https://obleas.novagnc.com.ar/auth/google/callback
PGHOST=168.231.93.65
PGPORT=5435
PGDATABASE=cdp_nova
PGUSER=gnc_admin
PGPASSWORD=<ver en MAPA-SISTEMA.md o en S18 .env>
```

---

## Pendientes conocidos

1. **Guía de uso para Yhonny** — documento operativo paso a paso
2. **Importar datos desde enargas_data** — mostrar meses disponibles para seleccionar en vez de subir CSV manual
3. **Importación automática a ManyChat** — post-limpieza de teléfonos, Yhonny solo hace el broadcast
4. **Force mode** — configurar URL alternativa en Configuración para saltear caché del worker
5. **Sincronizar estructura local ↔ S18** — la carpeta `app/` local no existe en S18; evaluar unificar con un deploy script o action de GitHub

---

## Comandos útiles de diagnóstico

```bash
# Ver logs del container
ssh akeneo@100.72.42.104 "docker logs sistema-obleas --tail 50"

# Ver períodos guardados
ssh akeneo@100.72.42.104 "ls /home/akeneo/sistema-obleas-app/data/periodos/"

# Estado del container
ssh akeneo@100.72.42.104 "docker ps | grep obleas"

# Test endpoint
curl -s -o /dev/null -w "%{http_code}" https://obleas.novagnc.com.ar/login
```
