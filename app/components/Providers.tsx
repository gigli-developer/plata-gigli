"use client";

import { SWRConfig } from "swr";

// Caché global de datos. "Stale-while-revalidate":
// - muestra lo cacheado al instante al cambiar de pestaña (cero pantalla en blanco)
// - considera la data fresca por 30s (no toca la red si navegás rápido)
// - revalida en segundo plano al volver a la app / reconectar
export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        dedupingInterval: 30000,
        revalidateOnFocus: true,
        revalidateOnReconnect: true,
        keepPreviousData: true,
      }}
    >
      {children}
    </SWRConfig>
  );
}
