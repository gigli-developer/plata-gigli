"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Número que cuenta hasta su valor al aparecer.
 *
 * Por qué es un componente y no un escaneo del DOM: el prototipo del rediseño
 * animaba buscando elementos en JetBrains Mono y leyéndoles el texto. Eso tiene
 * un problema conocido — si el componente se vuelve a renderizar en medio de la
 * animación, el escáner lee el texto INTERMEDIO como si fuera el nuevo objetivo
 * y el número espirala hacia cero. En Plata pasaría todo el tiempo: cada
 * pantalla pinta primero el caché de localStorage y a los milisegundos vuelve a
 * renderizar con los datos frescos de Supabase.
 *
 * Acá el valor es siempre la prop: no se lee nada del DOM, así que no hay forma
 * de que la animación se muerda la cola.
 *
 * Cuando el valor cambia (llega el dato fresco), interpola DESDE EL ANTERIOR y
 * no desde cero: se ve como un ajuste y no como un recuento completo.
 */
export default function CountUp({
  value,
  format,
  duration = 1200,
  className,
}: {
  value: number;
  /** Cómo mostrar el número en cada frame: ars, compact, usd… */
  format: (n: number) => string;
  duration?: number;
  className?: string;
}) {
  // Arranca en el valor final: así el HTML del servidor y el primer render del
  // cliente coinciden (si mostrara 0, React avisaría por hidratación).
  const [shown, setShown] = useState(value);
  // Lo que se está viendo AHORA en pantalla. Es el punto de partida cuando el
  // valor cambia a mitad de animación: arrancar del `value` anterior daría un
  // salto visible (venía mostrando 5.000 de 10.000 y saltaría a 10.000 para
  // recién ahí animar hacia el nuevo). En Plata esto pasa en cada pantalla: se
  // pinta el caché y milisegundos después llega el dato fresco de Supabase.
  const enPantalla = useRef(value);
  const primero = useRef(true);
  const raf = useRef<number | null>(null);

  const mostrar = (n: number) => { enPantalla.current = n; setShown(n); };

  useEffect(() => {
    const reduce = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // Sin animación: reduced-motion, valor no numérico, o pestaña en segundo
    // plano (ahí el navegador ni siquiera va a llamar a requestAnimationFrame).
    if (reduce || !Number.isFinite(value) || document.hidden) { mostrar(value); primero.current = false; return; }

    const from = primero.current ? 0 : enPantalla.current;
    primero.current = false;
    if (from === value) { mostrar(value); return; }

    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min((t - t0) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      mostrar(p < 1 ? from + (value - from) * eased : value);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);

    // Red de seguridad: el navegador PAUSA requestAnimationFrame cuando la
    // pestaña se oculta o no compone frames, y como el texto solo se actualiza
    // dentro del tick, el número quedaría congelado en el valor viejo — es decir,
    // mostrando un saldo que no es el real. Este timeout garantiza que, animación
    // o no, el valor correcto termine en pantalla.
    const red = setTimeout(() => mostrar(value), duration + 150);

    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
      clearTimeout(red);
    };
  }, [value, duration]);

  return <span className={className}>{format(shown)}</span>;
}
