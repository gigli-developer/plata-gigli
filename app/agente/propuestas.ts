import { createClient } from "@/lib/supabase/client";
import type { ControlMoneda, HechoPropuesta, NetoPersona, OperacionPropuesta } from "./fraccionamiento";

/**
 * Lo único que esta pantalla le pide a la base: la tabla `propuestas` y sus dos
 * funciones. **No pasa por `lib/db.ts`** a propósito: ahí vive el modelo de Plata
 * (transacciones, deudas, tarjetas) y las propuestas no son parte de eso, son la
 * cola de lo que el agente quiere escribir. Mezclarlas obligaría a tocar el
 * archivo más cargado de la app para agregar una pantalla que no cambia nada de
 * lo que ya anda.
 *
 * El cliente sí es el de siempre (`@/lib/supabase/client`), así que la sesión y
 * la RLS son las mismas que en el resto de Plata.
 */

export type FilaPropuesta = {
  id: number;
  agente?: string;
  tipo: string;
  resumen: string;
  operaciones?: OperacionPropuesta[] | null;
  /** `numeric`: puede llegar como número o como texto. */
  monto_ars: number | string | null;
  motivo_confirmacion: string | null;
  estado: string;
  creada_en?: string;
  expira_en: string;
  resuelta_en?: string | null;
  resuelta_por?: string | null;
  error?: string | null;
  hechos?: HechoPropuesta[] | null;
  control?: ControlMoneda[] | null;
  neto_por_persona?: NetoPersona[] | null;
};

// ⚠️ `select("*")` a propósito, no una lista de columnas. Nombrar una columna que
// la base todavía no tiene hace fallar la consulta ENTERA, no esa columna:
// verificado contra producción el 15/09, cuando pedir `hechos` devolvía `42703
// column propuestas.hechos does not exist`.

/** Una propuesta por id. `null` si no existe o si RLS no la deja ver: la card lo dice. */
export async function traerPropuesta(id: number): Promise<FilaPropuesta | null> {
  const { data, error } = await createClient().from("propuestas").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as FilaPropuesta | null) ?? null;
}

// ── Resolver una propuesta ───────────────────────────────────────────────────
//
// `aplicar_propuesta` y `rechazar_propuesta` están otorgadas a `authenticated`,
// que es el rol con el que entra Lucas, y **no son SECURITY DEFINER**: corren como
// quien llama, así que la RLS sigue valiendo.
//
// Lo importante para la pantalla: **no tiran excepción cuando algo sale mal**.
// Devuelven `{ estado, error? }` y la fila YA quedó en su estado final (`obsoleta`,
// `expirada`, `fallida`…). Un `error` acá NO significa que no pasó nada.

/** Lo que devuelven las dos funciones. `estado` es `null` solo si la propuesta no existe. */
export type Resolucion = {
  estado: string | null;
  error?: string | null;
  resultado?: { mensaje?: string; filas?: unknown[]; detalle_tecnico?: string; operacion?: number } | null;
};

/**
 * Aplica una propuesta. **Escribe en los datos reales de Plata y no se deshace.**
 *
 * Se llama solo con el id: `p_turno` y `p_sesion_id` son para el agente, y la
 * función usa justamente su ausencia para anotar `resuelta_por = 'usuario'` y para
 * saltear el cerrojo de mismo turno.
 */
export async function aplicarPropuesta(id: number): Promise<Resolucion> {
  const { data, error } = await createClient().rpc("aplicar_propuesta", { p_id: id });
  if (error) throw error;
  return (data ?? { estado: null, error: "La base no respondió nada." }) as Resolucion;
}

/**
 * Rechaza una propuesta. El motivo es opcional: la función lo exige cuando el que
 * retira es el agente, y acá hay una persona que puede no querer explicarse.
 * `p_origen` queda en su default, `'usuario'`.
 */
export async function rechazarPropuesta(id: number, motivo?: string): Promise<Resolucion> {
  const limpio = motivo?.trim();
  const { data, error } = await createClient().rpc("rechazar_propuesta", {
    p_id: id,
    ...(limpio ? { p_motivo: limpio } : {}),
  });
  if (error) throw error;
  return (data ?? { estado: null, error: "La base no respondió nada." }) as Resolucion;
}
