const ars0 = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
export const ars = (n: number) => ars0.format(n);
export const usd = (n: number) => "US$ " + n.toLocaleString("es-AR");
export const compact = (n: number) => {
  const a = Math.abs(n);
  const s = n < 0 ? "−" : "";
  if (a >= 1_000_000) return s + "$" + (a / 1_000_000).toFixed(2).replace(".", ",") + "M";
  if (a >= 10_000) return s + "$" + Math.round(a / 1_000) + "k";
  return s + "$" + Math.round(a).toLocaleString("es-AR");
};

/**
 * Parsea un monto tipeado por el usuario en formato argentino: punto = miles,
 * coma = decimales. `"1.500,50"` → 1500.5
 *
 * Existía en tres variantes distintas repartidas por la app y dos rompían datos
 * al ESCRIBIR:
 *   - `.replace(/[^\d.]/g,"")`  → "1.500" quedaba en 1,5   (÷1000)
 *   - `.replace(/[^\d]/g,"")`   → "10,50" USD quedaba 1050 (×100)
 * El segundo pasa desapercibido en pesos y es destructivo en USD/USDT.
 */
export const parseAmount = (s: string): number => {
  const limpio = s.trim().replace(/[^\d.,-]/g, "");
  if (!limpio) return 0;

  let normalizado: string;
  if (limpio.includes(",")) {
    // Hay coma → es el decimal, y los puntos son miles. "1.500,50" → 1500.5
    normalizado = limpio.replace(/\./g, "").replace(",", ".");
  } else {
    // Solo puntos: ambiguo. Un único punto seguido de exactamente 3 dígitos es
    // separador de miles ("1.500" = mil quinientos); en cualquier otro caso es
    // decimal ("1515.00" = mil quinientos quince, "1.5" = uno y medio).
    // Esto importa porque los inputs se prellenan con `toFixed(2)` y `String(n)`,
    // que producen punto decimal: sin esta rama, "1515.00" se leía como 151500 y
    // el conversor de divisas daba un resultado 100 veces menor.
    const puntos = (limpio.match(/\./g) ?? []).length;
    const milesSimple = puntos === 1 && /\.\d{3}$/.test(limpio);
    normalizado = puntos > 1 || milesSimple ? limpio.replace(/\./g, "") : limpio;
  }

  const n = Number(normalizado);
  return Number.isFinite(n) ? n : 0;
};

/** Igual que compact() pero en dólares. Los umbrales bajan: US$ 9.564 no es "9k". */
export const compactUsd = (n: number) => {
  const a = Math.abs(n);
  const s = n < 0 ? "−" : "";
  if (a >= 100_000) return s + "US$ " + (a / 1_000).toFixed(0) + "k";
  return s + "US$ " + Math.round(a).toLocaleString("es-AR");
};
