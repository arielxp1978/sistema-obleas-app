# Pendientes — sistema-obleas

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
