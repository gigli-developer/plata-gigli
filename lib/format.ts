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

/** Igual que compact() pero en dólares. Los umbrales bajan: US$ 9.564 no es "9k". */
export const compactUsd = (n: number) => {
  const a = Math.abs(n);
  const s = n < 0 ? "−" : "";
  if (a >= 100_000) return s + "US$ " + (a / 1_000).toFixed(0) + "k";
  return s + "US$ " + Math.round(a).toLocaleString("es-AR");
};
