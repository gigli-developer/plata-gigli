/**
 * Leer los números que dice el asistente, para poder chequearlos.
 *
 * Por qué hace falta: las herramientas están auditadas contra la base cruda y
 * cierran al peso (111 comprobaciones). Pero entre la herramienta y el usuario
 * hay un modelo que redacta, y ahí se cuelan errores que no se ven en ningún
 * lado. Medido: preguntando por el gasto más grande de la semana contestó
 * **"diecinueve mil ciento veintidós"** cuando la fila dice 18.122 — un dígito,
 * dicho con toda naturalidad, sobre datos perfectamente correctos.
 *
 * No alcanza con pedírselo en el prompt (ya está pedido). Lo que se puede hacer
 * es LEER lo que dijo y compararlo contra los números que efectivamente le
 * dieron las herramientas. Como el canal es de voz, los números vienen dichos en
 * palabras ("un millón doscientos mil"), así que hay que parsearlos.
 */

const UNIDADES: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21, veintidos: 22,
  veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26,
  veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40,
  cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400,
  quinientos: 500, seiscientos: 600, setecientos: 700, ochocientos: 800,
  novecientos: 900,
};
const ESCALAS: Record<string, number> = { mil: 1e3, millon: 1e6, millones: 1e6 };
const ES_NUMERO = (p: string) => p in UNIDADES || p in ESCALAS || p === "y";

const sinTildes = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Acumulador clásico. Los tokens pueden ser número (dígitos) o palabra. */
function valorDe(tokens: (number | string)[]): number {
  let total = 0;
  let actual = 0;
  for (const t of tokens) {
    if (t === "y") continue;
    if (typeof t === "number") actual += t;
    else if (t in UNIDADES) actual += UNIDADES[t];
    else if (t === "mil") {
      actual = (actual || 1) * 1000;
      total += actual;
      actual = 0;
    } else {
      total = ((total + actual) || 1) * 1e6;
      actual = 0;
    }
  }
  return total + actual;
}

/**
 * Todos los números de un texto, dichos con palabras, con dígitos o mezclados
 * ("32 mil 557", que es como contesta la mitad de las veces).
 */
export function numerosDeTexto(texto: string): number[] {
  const t = sinTildes(texto);
  const hallados: number[] = [];
  let corrida: (number | string)[] = [];

  const cerrar = () => {
    if (corrida.length) hallados.push(valorDe(corrida));
    corrida = [];
  };

  for (const m of t.matchAll(/\d[\d.]*(?:,\d+)?|[a-zñ]+/g)) {
    const tk = m[0];
    if (/^\d/.test(tk)) {
      // "1.234.567" son separadores de miles; "2,27" es un decimal.
      const [entero, dec] = tk.replace(/\.(?=\d{3}\b)/g, "").split(",");
      corrida.push(Number(entero.replace(/\.$/, "")) + (dec ? Number(`0.${dec}`) : 0));
    } else if (ES_NUMERO(tk)) {
      corrida.push(tk);
    } else {
      cerrar();
    }
  }
  cerrar();
  return hallados.filter((n) => n > 0);
}

/** Todos los números que aparecen en un resultado de herramienta, a cualquier profundidad. */
export function numerosDeDatos(valor: unknown, salida = new Set<number>()): Set<number> {
  if (typeof valor === "number") {
    if (Number.isFinite(valor)) salida.add(Math.abs(valor));
  } else if (typeof valor === "string") {
    // También los que van adentro de un texto: "vence 06/09", "2026-08".
    for (const m of valor.matchAll(/\d[\d.,]*/g)) {
      const n = Number(m[0].replace(/\.(?=\d{3}\b)/g, "").replace(",", ".").replace(/[.,]$/, ""));
      if (Number.isFinite(n)) salida.add(Math.abs(n));
    }
  } else if (Array.isArray(valor)) {
    for (const v of valor) numerosDeDatos(v, salida);
  } else if (valor && typeof valor === "object") {
    for (const v of Object.values(valor)) numerosDeDatos(v, salida);
  }
  return salida;
}

/** Debajo de esto no vale la pena mirar: cantidades, días del mes, cuotas. */
const PISO = 1000;

/**
 * ¿Este número se puede justificar con los datos que recibió?
 *
 * Dos varas, porque redondear al hablar es correcto y no hay que castigarlo:
 *   · exacto-ish (2%) contra cualquier número que le hayan dado, o
 *   · si lo que dijo es una cifra CLARAMENTE redondeada ("más de quinientos mil"),
 *     se acepta hasta un 10%. Sin esto, "quinientos mil" por 521.880 daría falso
 *     positivo, que es una frase perfectamente honesta.
 *
 * Un 19.122 contra un 18.122 no zafa por ninguna de las dos: no es redondeo, es
 * otro número.
 */
function justificable(dicho: number, permitidos: Set<number>): boolean {
  for (const p of permitidos) {
    if (Math.abs(dicho - p) <= Math.max(p * 0.02, 1)) return true;
  }
  // ¿Es una cifra redondeada? Ej: 500.000 lo es; 19.122 no.
  const magnitud = 10 ** Math.floor(Math.log10(dicho));
  const esRedondo = dicho % (magnitud / 10 || 1) === 0 && dicho % magnitud === 0
    ? true
    : dicho % (magnitud / 2) === 0;
  if (!esRedondo) return false;
  for (const p of permitidos) {
    if (Math.abs(dicho - p) <= p * 0.1) return true;
  }
  return false;
}

/**
 * Los números del texto que NO se pueden justificar con lo que devolvieron las
 * herramientas. Lista vacía = todo lo que dijo sale de los datos.
 */
export function numerosSinRespaldo(texto: string, datos: unknown[]): number[] {
  const permitidos = new Set<number>();
  for (const d of datos) numerosDeDatos(d, permitidos);
  if (!permitidos.size) return [];
  return [...new Set(numerosDeTexto(texto))]
    .filter((n) => n >= PISO && !justificable(n, permitidos));
}

/**
 * Qué números de los datos se parecen al que dijo mal.
 *
 * Señalarle el error no alcanzaba: dijo **88.122** por 18.122, se le avisó, y en
 * la reescritura lo volvió a decir mal. Con el candidato al lado —"quisiste decir
 * 18.122"— el trabajo deja de ser buscar y pasa a ser copiar.
 */
export function candidatosPara(dicho: number, datos: unknown[], cuantos = 3): number[] {
  const permitidos = new Set<number>();
  for (const d of datos) numerosDeDatos(d, permitidos);
  return [...permitidos]
    .filter((p) => p >= PISO)
    // Distancia relativa: 88.122 está mucho más cerca de 18.122 que de 76.642,
    // aunque en valor absoluto la cuenta dé al revés.
    .map((p) => ({ p, d: Math.abs(Math.log10(p / dicho)) }))
    .filter((x) => Number.isFinite(x.d) && x.d < 1)
    .sort((a, b) => a.d - b.d)
    .slice(0, cuantos)
    .map((x) => x.p);
}
