# Medir la gestión de obleas y PH — ideas de Ariel (2026-10-03)

> Documento de captura. **Nada de esto está construido ni aprobado para construir.** Lo que cambia
> el diseño "Obleas por asesor" (CEO-185) pasa por el CEO: ver encargo **CEO-202**.

## 1. Lo que dijo Ariel (textual, tal como lo pasó)

> Es un buen punto el que planteas del envio pero si vos te pones a pensar que el objetivo princiapl es hacer
> cada mes un poco mas de obleas y un poco mas de ph * recuerdo que cuando modifique el sistema ahora le puse que
> te permita asignar los clietnes de obleas ph a los distintos asesores para que al asesor le figure su propia
> lista a gestionar en este mes, y que pueda ir viendo la evolucion10 y el 26 de cada mes si o si necesitas
> arrancar al comienzo de mes para que la agenda empiece a funcionar.
>
> El problema es que como el cliente sigue cargando siende que la esta renovando antes [...] en una de esas
> podemos arrancar con obleas y ph las tratamos de meter a mitad de mes y ver que sucede. el otro tema es ver que
> los chicos que devolucion nos dan porque las ph quedamos en llamarlos y demas pero no tengo info de que dijo los
> clientes y si los llamaron o no.
>
> ahi leo lo que pusiste vos de mas o menos como respondio la gente pero para que ese dato sea util hace falta esto
> * cantidad de cliente de ph xxxx
> * cantidad de llamadas que se realizaron xxx
> * motivo esperando tarjeta xx
> * motivo yo te llamo xx
> * motivo estamos en el traajo xx
> * respondieron y se hizo la ph xx
> * categorizarlas de alguna manera simple pero para enteder que sucede
> * con esa info en la prox tanda si podemos trabajar en ver que cambiamos para ver si mejora o no y medir de
>   nuevo para ver los resultados.

(El texto original venía con un fragmento repetido por un error al pegar; se sacó la repetición.)

## 2. Lo que se entiende, ordenado

**Objetivo principal:** cada mes hacer **un poco más de obleas y un poco más de PH** que el anterior. Todo lo
demás (envíos, asesores, reportes) se mide contra eso.

**Calendario de la agenda:** la asignación de clientes a asesores (CEO-185) tiene que arrancar **a comienzo de
mes** para que la agenda de cada asesor funcione. Hay hitos de seguimiento los días **10 y 26** de cada mes
*(a confirmar con Ariel qué pasa exactamente esos días)*.

**Problema detectado:** el cliente renueva **antes** de que le llegue la gestión (renovación anticipada), así
que mandar todo junto a principio de mes puede no ser lo mejor.

**Prueba propuesta (experimento):** arrancar el mes **solo con obleas**, y meter las **PH a mitad de mes**.
Después comparar contra los meses en que salió todo junto.

**Falta de información sobre las PH:** quedamos en llamar a los clientes de PH, pero **no sabemos si los
llamaron ni qué respondieron**. Sin eso no se puede corregir nada.

## 3. El tablero de seguimiento de PH que pidió (por mes y por tanda)

| Indicador | De dónde podría salir | Carga manual |
|---|---|---|
| Clientes de PH del mes | Período de obleas (grupos `ph_urgente` + `ph`) — ya existe | No |
| Llamadas realizadas | **CDR de la central Issabel** (proyecto `telefonia`), cruzando por teléfono del cliente | **No** — sale sola |
| Llamadas atendidas / no atendidas | CDR (duración / estado) | No |
| Motivo: esperando la tarjeta | El asesor lo marca | Sí |
| Motivo: "yo te llamo" | El asesor lo marca | Sí |
| Motivo: "estoy en el trabajo" | El asesor lo marca | Sí |
| Respondió y se hizo la PH | Verificación Post-Envío (renovó con nosotros) — ya existe | No |

**Categorías simples de motivo (propuesta, 5 botones como máximo):**
1. Lo va a hacer — esperando la tarjeta / la plata
2. Me llama él / "yo te llamo"
3. No puede ahora — trabajo / horario
4. Ya lo hizo en otro lado / vendió el auto / se mudó
5. No le interesa

**Idea para que no complique a los chicos:** lo que se puede saber solo (cantidad, llamadas, si renovó) no se le
pide a nadie. Lo único manual es el motivo, con un solo toque (botón o etiqueta en ManyChat, donde ya trabajan).

**Ciclo de mejora:** medir → cambiar una sola cosa en la próxima tanda → medir de nuevo → comparar.

⚠️ **Dato a verificar:** "se hizo la PH" ≠ "renovó la oblea". La verificación actual mira la oblea; si una PH
se cuenta aparte, hay que ver si el vencimiento del cilindro (`vencimiento_cilindro_mas_proximo` en
`enargas_data.historial_obleas_datos`) sirve para detectarla.

## 4. Relación con lo que ya existe

- **CEO-185 "Obleas por asesor"** (`agente-ceo/disenos/obleas-por-asesor-CEO-185.md`): asigna las tandas a
  asesores y mide % de renovación por asesor. **Excluyó a propósito el "registro de gestión"** (D3, 25/09:
  *"no quiero que los chicos se compliquen más por ahora"*). El tablero de la sección 3 **es** ese registro →
  cambia el diseño → lo decide el CEO con Ariel (encargo **CEO-202**).
- **OB-12** (pendiente en este proyecto): obleas escribe la cartera por asesor en `cdp.obleas_cartera`. Es la
  base donde se colgarían las llamadas y los motivos.
- **Filtro "Todas las PH"** en la Verificación Post-Envío (commit `4a2cc7c`, 2026-10-03): ya permite ver el
  resultado de las dos PH juntas.

## 5. Medición del mismo día: a dónde se van los clientes que perdemos

Muestra rápida (no cerrada) tomada de `enargas_data` el 2026-10-03: clientes con operación en nuestros talleres
en ago-sep 2025 (2.759 vehículos) y dónde tienen la oblea nueva.

- Renovaron con nosotros: **912** · En otro lado: **515** · Todavía sin oblea nueva: **1.332**
- De los 515 perdidos: **349 (68 %) se quedaron en Córdoba capital** (fueron a la competencia, no se mudaron),
  149 se fueron al interior de Córdoba y 17 a otra provincia.
- Talleres que más se llevaron: Forte (42), Guzmán (30), Mazzer — Carlos Paz (23), Frencia — Río Segundo (22),
  Advan (20), Biancardi (18).
- PEC que más se llevaron: Landesa 3147 (79), Tubo Jet 3166 (67), Quiroga 3176 (45), Hidrocil 3445 (35),
  Advan 3392 (26). Otros 85 siguieron con PEC Sorvicor 3145 pero en un taller ajeno.
- Datos disponibles para profundizar: ubicación del cliente (`nova_operaciones.latitud/longitud`) y de todos
  los talleres (`talleres_geo`, 1.677) → se puede medir si el taller nuevo le queda más cerca que el nuestro.

## 6. Respuestas y pedidos nuevos de Ariel (2026-10-03, segunda tanda)

**Por qué existe el broadcast — la ventana del 10 al 26:** el negocio **explota a fin de mes y en los primeros
5 días hábiles**, porque el usuario se entera en la estación de que no le cargan y sale a buscar taller. Entre el
**10 y el 26** la actividad de obleas y PH cae. El broadcast busca que vengan en esa ventana: **aplanar la curva**
y retener clientes. Por eso la gestión (agenda del asesor) tiene que arrancar a comienzo de mes.

**Calendario ya en marcha:** se trabaja con el mes de vencimiento. Octubre = obleas que vencen en octubre:
durante el mes todavía pueden cargar; desde el 1/11 la estación no debería cargarles. (La "prueba" de la versión
anterior de este doc era un malentendido: ya se está haciendo así, arranca con octubre.)

**Las llamadas se hacen desde la central** → el CDR de Issabel las puede contar.

**Motivos de las llamadas: por ahora A MANO.** Ariel: *"que los chicos hablen y lo anoten a mano por ahora, más
adelante vemos de poner todo en el sistema… ahora no lo quiero complicar"*. **No se construye carga de motivos
en ningún sistema** hasta que Ariel lo pida. (Las categorías de la sección 3 sirven como planilla para anotar.)

**Indicadores nuevos pedidos:**
1. **PH del mes pasado que no se hicieron.** Hipótesis: el cliente estira el gasto lo más posible, espera a que la
   estación no le cargue y recién ahí busca dónde hacer la PH. Medirlo: de los PH del mes M, cuántos siguen sin
   hacer en M+1, M+2…
2. **Clientes del interior / otras provincias** (Catamarca, La Rioja…) que aprovechan el viaje a Córdoba. Medir
   cuántos son y si vuelven con nosotros. → **Primera versión HECHA** en el bloque "¿A dónde se fueron?" (tabla
   "Clientes de otras provincias", por provincia del domicilio en el CSV).
3. **Acumulado del año de vehículos que nunca renuevan.** No es lo mismo demorar meses que no renovar nunca.
   Causas posibles: baja no declarada a ENARGAS, oblea trucha (la estación no la distingue y no queda registro),
   equipo de GNC sacado sin informar, y otras desconocidas. Necesita juntar todos los meses del año → va al
   tablero mensual (segunda parte), no al reporte de un mes.

**Segundo tablero (balance captados/perdidos + tendencia 12 meses + acumulado de no renovados):** dónde vive lo
define el CEO (CEO-202).

## 7. Hecho el 2026-10-03

- Filtro "Todas las PH (Urgente + PH)" en la Verificación Post-Envío (commit `4a2cc7c`).
- Bloque **"¿A dónde se fueron?"** en la Verificación Post-Envío (pantalla, CSV y página 2 del PDF): destino de
  los "Otro PEC" (Córdoba capital / interior / otra provincia), cuántos renovaron en su misma localidad, top 10
  talleres y PEC que se los llevaron, y clientes de otras provincias. Respeta el filtro de grupo de envío.
  Septiembre 2026: 59 perdidos → 31 capital, 24 interior, 4 otra provincia; 25 en su misma localidad.

## 8. Dudas para confirmar con Ariel

Respondidas las tres de la versión anterior (ver sección 6). Abierta:
1. ¿Dónde se guarda lo que los asesores anotan a mano, para poder contarlo al cierre del mes?
