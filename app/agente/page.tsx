import Chat from "./Chat";

/**
 * `/agente` — el agente de Plata, adentro de Plata.
 *
 * La página no hace nada: todo vive en `Chat.tsx`, que es cliente porque el chat
 * es un stream (SSE) y la card de la propuesta lee la fila mientras sigue abierta.
 */
export default function AgentePage() {
  return <Chat />;
}
