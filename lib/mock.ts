// Datos de ejemplo derivados del backup real de la base vieja.
// Sirven solo para maquetar el diseño; luego se reemplazan por datos de Supabase.

export const user = { name: "Nico", username: "UNLLUG" };

export const balance = {
  totalArs: 4_182_540,
  totalUsd: 2_860,
  changePct: 4.7, // vs mes anterior
};

export const month = {
  label: "Mayo 2026",
  ingresos: 3_108_941,
  egresos: 1_642_390,
  get ahorro() {
    return this.ingresos - this.egresos;
  },
};

export const cashflow = [
  { m: "Dic", in: 2_650_000, out: 1_980_000 },
  { m: "Ene", in: 2_900_000, out: 1_420_000 },
  { m: "Feb", in: 2_980_000, out: 1_870_000 },
  { m: "Mar", in: 3_050_000, out: 1_540_000 },
  { m: "Abr", in: 3_100_000, out: 2_010_000 },
  { m: "May", in: 3_108_941, out: 1_642_390 },
];

export const categories = [
  { name: "Compras", emoji: "🛍️", amount: 612_300, color: "#c8ff4d" },
  { name: "Delivery", emoji: "🛵", amount: 388_900, color: "#34e1a0" },
  { name: "Transporte", emoji: "🚕", amount: 254_100, color: "#5ec8ff" },
  { name: "Comida", emoji: "🍽️", amount: 198_700, color: "#a78bfa" },
  { name: "Servicios", emoji: "💡", amount: 121_500, color: "#ff9f5e" },
  { name: "Otros", emoji: "✨", amount: 66_890, color: "#6b7080" },
];

export type Tx = {
  id: number;
  desc: string;
  category: string;
  emoji: string;
  method: string;
  amount: number;
  currency: "ARS" | "USD" | "USDT";
  type: "ingreso" | "egreso";
  date: string;
  card?: string;
  source: "manual" | "ocr" | "email_visa" | "chat";
};

export const transactions: Tx[] = [
  { id: 201, desc: "PedidosYa", category: "Delivery", emoji: "🛵", method: "Tarjeta de Crédito", amount: 18_540, currency: "ARS", type: "egreso", date: "Hoy · 13:42", card: "Platinum Gal", source: "email_visa" },
  { id: 200, desc: "Sueldo JP Morgan", category: "Sueldo", emoji: "💼", method: "Transferencia", amount: 2_300_000, currency: "ARS", type: "ingreso", date: "Hoy · 09:01", source: "manual" },
  { id: 199, desc: "Uber", category: "Transporte", emoji: "🚕", method: "Tarjeta de Débito", amount: 6_820, currency: "ARS", type: "egreso", date: "Ayer · 22:15", source: "chat" },
  { id: 198, desc: "Carrefour Express", category: "Compras", emoji: "🛍️", method: "Tarjeta de Crédito", amount: 47_230, currency: "ARS", type: "egreso", date: "Ayer · 19:30", card: "Platinum Amex Gal", source: "ocr" },
  { id: 197, desc: "Farmacity", category: "Salud", emoji: "💊", method: "Tarjeta de Débito", amount: 23_400, currency: "ARS", type: "egreso", date: "Ayer · 11:05", source: "ocr" },
  { id: 196, desc: "Cambio USDT → ARS", category: "Cambio Divisas", emoji: "💱", method: "Transferencia", amount: 146_214, currency: "ARS", type: "ingreso", date: "06 May · 00:43", source: "manual" },
  { id: 195, desc: "HBO Max", category: "Servicios", emoji: "📺", method: "Tarjeta de Crédito", amount: 8_941, currency: "ARS", type: "egreso", date: "05 May · 08:00", card: "Platinum Gal", source: "manual" },
  { id: 194, desc: "Starbucks", category: "Comida", emoji: "☕", method: "Efectivo", amount: 5_600, currency: "ARS", type: "egreso", date: "04 May · 17:20", source: "chat" },
  { id: 193, desc: "Spotify", category: "Servicios", emoji: "🎧", method: "Tarjeta de Crédito", amount: 4_290, currency: "ARS", type: "egreso", date: "04 May · 08:00", card: "Platinum Gal", source: "email_visa" },
  { id: 192, desc: "Coto", category: "Compras", emoji: "🛒", method: "Tarjeta de Crédito", amount: 86_120, currency: "ARS", type: "egreso", date: "03 May · 20:10", card: "Platinum Amex Gal", source: "ocr" },
  { id: 191, desc: "Rappi", category: "Delivery", emoji: "🛵", method: "Tarjeta de Crédito", amount: 12_980, currency: "ARS", type: "egreso", date: "03 May · 13:25", card: "Platinum Gal", source: "email_visa" },
  { id: 190, desc: "Cabify", category: "Transporte", emoji: "🚕", method: "Tarjeta de Débito", amount: 8_300, currency: "ARS", type: "egreso", date: "02 May · 23:40", source: "chat" },
  { id: 189, desc: "Curso Udemy", category: "Educación", emoji: "📚", method: "Tarjeta de Crédito", amount: 14_999, currency: "USD", type: "egreso", date: "02 May · 16:00", card: "Platinum Amex Gal", source: "manual" },
  { id: 188, desc: "Alquiler Chañar II", category: "Inversiones", emoji: "🏠", method: "Transferencia", amount: 800_000, currency: "ARS", type: "ingreso", date: "01 May · 10:00", source: "manual" },
  { id: 187, desc: "Cine Hoyts", category: "Ocio", emoji: "🎬", method: "Efectivo", amount: 9_500, currency: "ARS", type: "egreso", date: "30 Abr · 21:15", source: "chat" },
  { id: 186, desc: "McDonald's", category: "Comida", emoji: "🍔", method: "Tarjeta de Crédito", amount: 11_200, currency: "ARS", type: "egreso", date: "30 Abr · 14:30", card: "Platinum Gal", source: "email_visa" },
];

export const cards = [
  { name: "Platinum Gal", bank: "Galicia", network: "VISA", last4: "2811", spentArs: 642_180, limitArs: 1_500_000, closeDay: 23, dueDay: 4, hue: "from-[#1b3a2e] to-[#0e1a16]" },
  { name: "Platinum Amex Gal", bank: "Galicia", network: "VISA", last4: "2878", spentArs: 318_540, limitArs: 1_200_000, closeDay: 23, dueDay: 4, hue: "from-[#2a2440] to-[#14111f]" },
];

export const upcoming = [
  { name: "Alquiler Chañar II", emoji: "🏠", amount: 800_000, type: "ingreso" as const, day: "05 Jun" },
  { name: "Resumen Platinum Gal", emoji: "💳", amount: 642_180, type: "egreso" as const, day: "04 Jun" },
  { name: "HBO Max", emoji: "📺", amount: 8_941, type: "egreso" as const, day: "05 Jun" },
];

export const debts = {
  toCollect: 25_730,
  toPay: 518_052,
  people: [
    { name: "Thiago", emoji: "🧑", amount: 518_052, type: "to_pay" as const, note: "Tricount Depa" },
    { name: "Branko", emoji: "🧑", amount: 246, type: "to_collect" as const, note: "Deuda" },
    { name: "Toto", emoji: "🧑", amount: 3_645, type: "to_collect" as const, note: "Café + Ads" },
  ],
};

export const exchangeRate = { pair: "USDT/ARS", value: 1_462.14, changePct: -0.9 };

// ---- Tarjetas: detalle + resúmenes (basado en card_statements) ----
export type CardDetail = {
  id: number;
  name: string;
  bank: string;
  network: string;
  last4: string;
  limitArs: number;
  closeDay: number;
  dueDay: number;
  hue: string;
  accent: string;
};

export const cardDetails: CardDetail[] = [
  { id: 1, name: "Platinum Gal", bank: "Galicia", network: "VISA", last4: "2811", limitArs: 1_500_000, closeDay: 23, dueDay: 4, hue: "from-[#10231c] via-[#0f2a20] to-[#0a1612]", accent: "#34e1a0" },
  { id: 2, name: "Platinum Amex Gal", bank: "Galicia", network: "VISA", last4: "2878", limitArs: 1_200_000, closeDay: 23, dueDay: 4, hue: "from-[#221c3a] via-[#1c1830] to-[#120f1f]", accent: "#a78bfa" },
];

export type Statement = {
  id: number;
  cardId: number;
  period: string;
  closing: string;
  due: string;
  totalArs: number;
  totalUsd: number;
  paid: boolean;
};

export const statements: Statement[] = [
  { id: 24, cardId: 1, period: "Mayo 2026", closing: "23 May", due: "04 Jun", totalArs: 642_180, totalUsd: 132.4, paid: false },
  { id: 22, cardId: 1, period: "Abril 2026", closing: "23 Abr", due: "04 May", totalArs: 588_900, totalUsd: 96.0, paid: true },
  { id: 20, cardId: 1, period: "Marzo 2026", closing: "23 Mar", due: "04 Abr", totalArs: 503_410, totalUsd: 80.5, paid: true },
  { id: 18, cardId: 1, period: "Febrero 2026", closing: "23 Feb", due: "04 Mar", totalArs: 471_220, totalUsd: 64.2, paid: true },
  { id: 23, cardId: 2, period: "Mayo 2026", closing: "23 May", due: "04 Jun", totalArs: 318_540, totalUsd: 41.0, paid: false },
  { id: 21, cardId: 2, period: "Abril 2026", closing: "23 Abr", due: "04 May", totalArs: 284_750, totalUsd: 22.5, paid: true },
  { id: 19, cardId: 2, period: "Marzo 2026", closing: "23 Mar", due: "04 Abr", totalArs: 312_980, totalUsd: 30.0, paid: true },
];

export type Installment = {
  id: number;
  cardId: number;
  desc: string;
  emoji: string;
  monthly: number;
  current: number;
  total: number;
};

export const installments: Installment[] = [
  { id: 1, cardId: 1, desc: "Notebook Lenovo", emoji: "💻", monthly: 91_600, current: 3, total: 12 },
  { id: 2, cardId: 1, desc: "Pasaje Aerolíneas", emoji: "✈️", monthly: 145_000, current: 2, total: 6 },
  { id: 3, cardId: 2, desc: "Heladera Samsung", emoji: "🧊", monthly: 78_300, current: 5, total: 9 },
];

// ---- Catálogos (para filtros y formulario) ----
export const categoryOptions = [
  { name: "Compras", emoji: "🛍️" },
  { name: "Delivery", emoji: "🛵" },
  { name: "Comida", emoji: "🍽️" },
  { name: "Transporte", emoji: "🚕" },
  { name: "Servicios", emoji: "💡" },
  { name: "Salud", emoji: "💊" },
  { name: "Educación", emoji: "📚" },
  { name: "Ocio", emoji: "🎬" },
  { name: "Inversiones", emoji: "🏠" },
  { name: "Cambio Divisas", emoji: "💱" },
  { name: "Sueldo", emoji: "💼" },
  { name: "Regalos", emoji: "🎁" },
  { name: "Otros", emoji: "✨" },
];

export const paymentMethods = ["Tarjeta de Crédito", "Tarjeta de Débito", "Efectivo", "Transferencia"];
export const currencies = ["ARS", "USD", "USDT"];

// ---- Divisas ----
// Cotizaciones "en vivo" (mock; luego vienen de una API tipo dolarapi.com)
export const liveQuotes = [
  { name: "Cripto · USDT", buy: 1_452.0, sell: 1_462.14, changePct: -0.9, accent: "#34e1a0" },
  { name: "Dólar Blue", buy: 1_440.0, sell: 1_465.0, changePct: 0.8, accent: "#c8ff4d" },
  { name: "Dólar MEP", buy: 1_450.0, sell: 1_455.0, changePct: 0.3, accent: "#5ec8ff" },
  { name: "Dólar Oficial", buy: 1_170.0, sell: 1_185.0, changePct: 0.1, accent: "#a78bfa" },
];

// Valor en ARS de cada moneda (para el conversor)
export const fxRatesToArs: Record<string, number> = { ARS: 1, USDT: 1_462.14, USD: 1_455.0 };

// Tenencias actuales
export const fxHoldings = [
  { currency: "USDT", amount: 1_240.0, emoji: "🪙" },
  { currency: "USD", amount: 1_620.0, emoji: "💵" },
];

// Tendencia USDT/ARS (últimos puntos) para el sparkline
export const fxTrend = [1438, 1445, 1441, 1452, 1460, 1457, 1468, 1476, 1471, 1465, 1459, 1462];

export type FxExchange = {
  id: number;
  from: string;
  to: string;
  fromAmount: number;
  toAmount: number;
  rate: number;
  date: string;
};

export const fxHistory: FxExchange[] = [
  { id: 2, from: "USDT", to: "ARS", fromAmount: 100, toAmount: 146_214, rate: 1_462.14, date: "06 May 2026" },
  { id: 1, from: "USDT", to: "ARS", fromAmount: 70.75, toAmount: 104_454, rate: 1_476.39, date: "29 Abr 2026" },
  { id: 4, from: "USD", to: "ARS", fromAmount: 200, toAmount: 291_000, rate: 1_455.0, date: "20 Abr 2026" },
  { id: 3, from: "USDT", to: "ARS", fromAmount: 50, toAmount: 72_300, rate: 1_446.0, date: "10 Abr 2026" },
];

// ---- Deudas ----
// kind: cash = movimiento real de dinero (préstamo, NO es gasto)
//       in_kind = en especie / favor (sin movimiento de plata)
//       split = gasto compartido (el gasto es real; solo tu parte es gasto tuyo)
export type DebtKind = "cash" | "in_kind" | "split";
export type DebtItem = {
  id: number;
  person: string;
  emoji: string;
  kind: DebtKind;
  direction: "to_collect" | "to_pay";
  status: "pending" | "settled";
  amount: number; // lo que se debe a/por vos
  currency: "ARS" | "USD";
  description: string;
  date: string;
  splitTotal?: number; // total del gasto (solo split)
  yourShare?: number; // tu parte (solo split)
  participants?: number; // cantidad de personas (solo split)
  linked?: string; // referencia a transacción/transferencia
};

export const debtItems: DebtItem[] = [
  { id: 1, person: "Toto", emoji: "🧉", kind: "cash", direction: "to_collect", status: "pending", amount: 5_000, currency: "ARS", description: "Le presté para el finde", date: "28 May", linked: "Transferencia" },
  { id: 2, person: "Beva", emoji: "🧥", kind: "in_kind", direction: "to_collect", status: "pending", amount: 30_000, currency: "ARS", description: "Le di una campera (valor estimado)", date: "22 May" },
  { id: 3, person: "Thiago", emoji: "🍽️", kind: "split", direction: "to_collect", status: "pending", amount: 90_000, currency: "ARS", description: "Cena Don Julio", date: "18 May", splitTotal: 120_000, yourShare: 30_000, participants: 4, linked: "Platinum Gal" },
  { id: 4, person: "Thiago", emoji: "🏠", kind: "cash", direction: "to_pay", status: "pending", amount: 518_052, currency: "ARS", description: "Tricount Depa", date: "03 May", linked: "Transferencia" },
  { id: 5, person: "Branko", emoji: "📣", kind: "split", direction: "to_collect", status: "pending", amount: 246, currency: "ARS", description: "Anuncios Facebook", date: "03 May", splitTotal: 492, yourShare: 246, participants: 2, linked: "Platinum Amex Gal" },
  { id: 6, person: "Toto", emoji: "☕", kind: "cash", direction: "to_collect", status: "settled", amount: 3_625, currency: "ARS", description: "Café", date: "03 Abr", linked: "Efectivo" },
];

export const persons = ["Toto", "Beva", "Thiago", "Branko"];
