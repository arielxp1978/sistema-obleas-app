# Sistema de Obleas GNC — Nova GNC

Sistema de gestión para procesamiento de datos de obleas ENARGAS, normalización de teléfonos y verificación post-campaña.

## Funcionalidades

- **Carga CSV**: Upload de archivos exportados de ENARGAS (separador `;`, soporta campos entre comillas)
- **Filtrado automático**: Reglas por TCODTAL (IRT0550 sin GNCOBS3, HIT0797, QUT0865)
- **Normalización de teléfonos**: Formato argentino 10 dígitos para WhatsApp
- **Revisión manual**: Grilla editable para corregir teléfonos con error leve
- **Ranking de usuarios**: % de error en carga de teléfonos por operador
- **Archivos de salida**: CSVs de 50 registros + descarga ZIP
- **Verificación post-envío**: Consulta API ENARGAS para clasificar renovaciones (con pausa y reanudación)
- **Historial**: Persistencia por período con dashboard acumulado
- **Gestión de períodos**: Crear, leer, listar y eliminar períodos

## Setup local

```bash
npm install
npm run dev    # con auto-reload (nodemon)
```

O para producción:

```bash
npm start
```

Abrir `http://localhost:3000`

## Variables de entorno

| Variable    | Descripción                     | Default    |
|-------------|--------------------------------|------------|
| `PORT`      | Puerto del servidor            | `3000`     |
| `APP_CLAVE` | Clave de acceso a la app       | `nova2026` |

> ⚠️ En producción, siempre configurar `APP_CLAVE` con un valor seguro.

## Deploy en Railway

1. Conectá este repo en [railway.app](https://railway.app)
2. Railway detecta Node.js automáticamente
3. Configurar variable `APP_CLAVE` en el panel de Railway

## API Endpoints

### Autenticación
- `POST /api/login` — Login con clave
- `POST /api/logout` — Cerrar sesión

### Procesamiento
- `POST /api/procesar` — Subir y procesar CSV
- `POST /api/generar-archivos` — Generar archivos CSV de salida

### Verificación
- `POST /api/verificar/iniciar` — Iniciar verificación contra API ENARGAS
- `POST /api/verificar/pausar` — Pausar verificación
- `POST /api/verificar/reanudar` — Reanudar verificación pausada
- `GET /api/verificar/estado` — Estado actual de la verificación

### Períodos
- `GET /api/periodos` — Listar períodos
- `GET /api/periodos/:id` — Obtener período
- `POST /api/periodos` — Guardar período
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
├── data/              # Datos persistidos (auto-generado)
└── uploads/           # Archivos temporales (auto-generado)
```

## Requisitos

- Node.js >= 18.0.0
