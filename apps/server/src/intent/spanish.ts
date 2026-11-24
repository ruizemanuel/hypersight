/**
 * Spanish (rioplatense and neutral) commands rewritten into the English the grammar reads:
 * "cerrá la mitad de mi eth" → "close half of my eth". Only Spanish-only words are touched, so
 * English text passes through unchanged (apart from accents, which the tokenizer drops anyway).
 */

const UNITS: Record<string, string> = {
  uno: 'one',
  dos: 'two',
  tres: 'three',
  cuatro: 'four',
  cinco: 'five',
  seis: 'six',
  siete: 'seven',
  ocho: 'eight',
  nueve: 'nine',
};
const WORDS: Record<string, string> = {
  ...UNITS,
  diez: 'ten',
  doce: 'twelve',
  trece: 'thirteen',
  catorce: 'fourteen',
  quince: 'fifteen',
  dieciseis: 'sixteen',
  diecisiete: 'seventeen',
  dieciocho: 'eighteen',
  diecinueve: 'nineteen',
  veinte: 'twenty',
  treinta: 'thirty',
  cuarenta: 'forty',
  cincuenta: 'fifty',
  sesenta: 'sixty',
  setenta: 'seventy',
  ochenta: 'eighty',
  noventa: 'ninety',
  cien: 'a hundred',
  ciento: 'one hundred',
  doscientos: 'two hundred',
  trescientos: 'three hundred',
  cuatrocientos: 'four hundred',
  quinientos: 'five hundred',
  // verbs (imperative, rioplatense voseo and infinitive)
  cerra: 'close',
  cerrar: 'close',
  cierra: 'close',
  cierre: 'close',
  cerrame: 'close',
  compra: 'buy',
  comprar: 'buy',
  compre: 'buy',
  comprame: 'buy',
  vende: 'sell',
  vender: 'sell',
  venda: 'sell',
  cancela: 'cancel',
  cancelar: 'cancel',
  cancele: 'cancel',
  abri: 'open',
  abrir: 'open',
  abre: 'open',
  segui: 'watch',
  seguir: 'watch',
  sigue: 'watch',
  // everything else the grammar needs
  todo: 'all',
  toda: 'all',
  todos: 'all',
  todas: 'all',
  mitad: 'half',
  mi: 'my',
  mis: 'my',
  de: 'of',
  en: 'on',
  por: 'for',
  si: 'yes',
  dolares: 'dollars',
  dolar: 'dollars',
  ordenes: 'orders',
  largo: 'long',
  corto: 'short',
  saldo: 'balance',
  precio: 'price',
  probabilidad: 'odds',
  probabilidades: 'odds',
  ganancia: 'pnl',
  ganancias: 'pnl',
  un: 'a',
  una: 'a',
  y: 'and',
};

const TENS = 'veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa';
const UNIT = Object.keys(UNITS).join('|');

const PHRASES: [RegExp, string][] = [
  [/\bpor favor\b/g, ' '],
  [/\bcuant[oa]s? (gano|voy ganando|estoy ganando|llevo ganado|gane|voy)\b/g, 'what is my pnl'],
  [/\bcuanto (vale|esta|cuesta)\b/g, 'what is the price of'],
  [/\bla mitad\b/g, 'half'],
  [/\bun cuarto\b/g, 'a quarter'],
  // "treinta y cinco" → "thirty five"; "veintidos" → "twenty two"
  [new RegExp(`\\b(${TENS}) y (${UNIT})\\b`, 'g'), '$1 $2'],
  [new RegExp(`\\bveinti(${UNIT})\\b`, 'g'), 'veinte $1'],
  [/\bveintiun\b/g, 'veinte uno'],
  [
    new RegExp(`\\b(${UNIT}|diez|cien|doscientos|trescientos|quinientos) mil\\b`, 'g'),
    '$1 thousand',
  ],
  [/\bmil\b/g, 'a thousand'],
];

export function fromSpanish(text: string): string {
  // "cerrá" → "cerra", "dólares" → "dolares": accents split off (NFD), then dropped.
  let s = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[¿¡]/g, ' ');
  for (const [re, to] of PHRASES) s = s.replace(re, to);
  return s.replace(/[a-z]+/g, (w) => WORDS[w] ?? w);
}
