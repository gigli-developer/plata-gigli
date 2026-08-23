/**
 * Los criterios de Lucas para razonar sobre SU plata.
 *
 * ## Por qué esto es un archivo del servidor y no una nota del cerebro
 *
 * El plan original decía «el sub-agente lo trae vía la herramienta cerebro» — y
 * es imposible por diseño: `cerebro` devuelve una ACCIÓN que ejecuta la PC
 * contra su disco, y estos sub-agentes corren en Railway, que nunca ve el
 * cerebro (decisión 2026-08-17: las notas no salen de la máquina).
 *
 * El arreglo es una copia declarada: la FUENTE DE VERDAD vive en
 * `cerebro/oficios/criterios-plata.md` (verificable, versionada por OneDrive) y
 * ESTE archivo es su copia para el servidor. Cuando cambie la nota, cambia esto
 * en el mismo acto — el encabezado de la nota apunta acá y viceversa, para que
 * el drift se vea. Es la misma jugada que `numeros.py` ↔ `numeros.ts`:
 * duplicado a propósito y documentado, no por descuido.
 *
 * ## Estado
 *
 * ⚠️ TODAVÍA SIN ENTREVISTA. Lo de abajo es el criterio conservador de
 * arranque, derivado de las decisiones ya tomadas en el proyecto (CLAUDE.md y
 * la bitácora del cerebro), no de las respuestas de Lucas. La entrevista
 * (cuotas vs contado, inflación y dólar, umbral de optimización, categorías
 * especiales) reemplaza este bloque.
 */
export const CRITERIOS = `CRITERIOS DE LUCAS (provisorios, sin entrevista todavía — decilo si pesa en la respuesta):
- Conservador con la deuda: una cuota que no venció es un compromiso a futuro y
  vale el dólar de hoy, no el del día que se tomó.
- Los dólares y USDT se valúan a compra (lo que de verdad recibís al vender);
  un consumo en dólares se piensa a venta (lo que el banco cobra).
- Un flujo pasado quedó congelado a su cotización; lo que se tiene va en vivo.
- Preferí que falte un dato y decirlo antes que estimar de cabeza.
- Los préstamos a otros y los cambios de divisas NO son gasto: mueven plata de
  bolsillo, el patrimonio no cambia.`;
