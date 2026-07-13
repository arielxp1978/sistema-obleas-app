# Pendientes — sistema-obleas

## Sesión 2026-07-13

### Implementado — Importación desde base (InfoSys)
- Nueva sección **"🗓️ Traer desde InfoSys"** en la pestaña Archivos: selector de mes de vencimiento (default = mes actual) → trae obleas de talleres Nova desde `nova_operaciones` sin subir CSV. Upload de CSV intacto como respaldo.
- Endpoints nuevos: `GET /api/base/periodos` y `GET /api/base/importar?mes=&tipo=`. Reusan el mismo pipeline y render que el CSV (`procesarRows` en procesar.js).
- Deployado a S18 y verificado end-to-end (jul-2026 → 1522 registros). Backup en S18 `_deploy_backups/`.

### Estado obleas/PH
- Se muestra **todo como obleas** (flag `MOSTRAR_PH=false` en index.html). El split obleas/PH ya está programado pero apagado.
- **Bloqueado por ES-12 (Enargas Scrap):** InfoSys todavía no manda los campos de cilindro/PH (CUPH*). Cuando ES-12 cierre → prender `MOSTRAR_PH=true`.

### Próximo paso concreto
- Esperar respuesta de Sebastián Fanitini (InfoSys) con los campos de cilindro/PH. Al llegar y cargarse vía ES-12, activar el flag y verificar el split obleas/PH.

## Sesión 2026-05-14

### Implementado
- **Pre-carga por número de oblea** (`/api/precarga` → `POST /api/consulta-oblea` en Enargas Scrap)
  - Botón "Pre-cargar en Worker" en la pestaña Verificación
  - Batchea las obleas del CSV en grupos de 50
  - Muestra progreso en tiempo real
  - Rellena cache `consultas_gnc` antes de que corra la verificación
  - Elimina los "reintentar en 90s" para obleas ya renovadas

### Próximo paso concreto
- **Probar en producción**: Subir un CSV real de obleas renovadas, presionar "Pre-cargar en Worker", esperar que termine, luego ejecutar "Verificar". Confirmar que no aparecen "reintentar en 90s".
- Si hay obleas sin renovar (realmente vencidas), esas seguirán usando el path patente→S14 en verificación normal — eso es correcto.

### Deuda técnica conocida
- `lib/verificar.js` sigue usando el path patente (S14 worker) para la verificación principal. Para obleas pre-cargadas, la respuesta del worker ya tiene los datos en cache → velocidad OK. Para obleas sin renovar, S14 sigue siendo la única fuente.
- Si en el futuro se quiere verificación 100% por oblea (sin S14), habría que refactorizar `verificar.js` para llamar a `/api/consulta-oblea` en lugar de `/api/consulta?patente=...`.
