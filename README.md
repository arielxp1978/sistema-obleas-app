# Sistema de Obleas GNC — Nova GNC

Sistema de gestión para el procesamiento de datos de obleas ENARGAS, normalización de teléfonos y verificación post-campaña.

## Funcionalidades

- **Carga CSV**: Upload de archivos exportados de ENARGAS (separador `;`, soporta campos entre comillas)
- **Filtrado automático**: Reglas por `TCODTAL` (IRT0550 sin GNCOBS3, HIT0797, QUT0865)
- **Normalización de teléfonos**: Formato argentino 10 dígitos para WhatsApp
- **Revisión manual**: Grilla editable con columna `+549` indicadora y contador de dígitos en tiempo real
- **Ranking de usuarios**: % de error en teléfonos por operador (sobre la base **filtrada**)
- **Archivos de salida**: CSVs de 50 registros — excluye teléfonos RECHAZAR — columnas reducidas (8 campos) + descarga ZIP
- **Verificación post-envío**: Consulta API ENARGAS para clasificar renovaciones (pausa/reanudación)
- **Historial**: Persistencia por período con dashboard acumulado

## Códigos de negocio

### PEC (comisionistas)
| Código | Nombre |
|--------|--------|
| `3145` | Sorvicor SRL |
| `3286` | Grupo P5 SRL |

### Talleres (TCODTAL)
| Código | Nombre |
|--------|--------|
| `IRT0550` | Nova Gral Paz (Sorvicor SRL) |
| `HIT0797` | Nova R20 (Nova GNC SRL) |
| `QUT0865` | Nova R20 (Grupo P5 SRL) |

## Setup local

```bash
npm install
npm run dev    # con auto-reload (nodemon)
```

O para producción:

```bash
npm start
```

Abrir `http://localhost:3000` — clave default: `nova2026`

## Variables de entorno

| Variable    | Descripción                     | Default    |
|-------------|--------------------------------|------------|
| `PORT`      | Puerto del servidor            | `3000`     |
| `APP_CLAVE` | Clave de acceso a la app       | `nova2026` |

> ⚠️ En producción, siempre configurar `APP_CLAVE` con un valor seguro.

## Deploy con Docker

```bash
docker-compose up -d
# → http://localhost:3080
```

## Deploy en Railway

1. Conectar este repo en [railway.app](https://railway.app)
2. Railway detecta Node.js automáticamente
3. Configurar variable `APP_CLAVE` en el panel de Railway

## API Endpoints

### Autenticación
- `POST /api/login` — Login con clave
- `POST /api/logout` — Cerrar sesión

### Procesamiento
- `POST /api/procesar` — Subir y procesar CSV
- `POST /api/generar-archivos` — Generar CSVs de salida (excluye RECHAZAR, 8 columnas)

### Verificación
- `POST /api/verificar/iniciar` — Iniciar verificación contra API ENARGAS
- `POST /api/verificar/pausar` — Pausar verificación
- `POST /api/verificar/reanudar` — Reanudar verificación pausada
- `POST /api/verificar/cancelar` — Cancelar verificación
- `GET /api/verificar/estado` — Estado actual de la verificación (polling)

### Períodos
- `GET /api/periodos` — Listar períodos guardados
- `GET /api/periodos/:id` — Obtener período completo
- `POST /api/periodos` — Guardar/actualizar período
- `DELETE /api/periodos/:id` — Eliminar período
- `GET /api/historial` — Historial acumulado

### Configuración
- `GET /api/config` — Obtener configuración
- `POST /api/config` — Guardar configuración

## Estructura

```
app/
├── server.js          # Express server + API routes
├── lib/
│   ├── normalizar.js  # Normalización teléfonos argentinos
│   ├── procesar.js    # Pipeline CSV completo
│   ├── verificar.js   # Verificación API ENARGAS
│   └── storage.js     # Persistencia JSON por período
├── public/
│   ├── index.html     # Dashboard principal (8 pestañas)
│   ├── historial.html # Dashboard histórico acumulado
│   └── login.html     # Página de login
└── data/              # Datos persistidos (auto-generado)
    ├── config.json    # Configuración del sistema
    └── periodos/      # Períodos guardados (ej: 4-2026.json)
```

## Requisitos

- Node.js >= 18.0.0
