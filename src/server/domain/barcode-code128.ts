/**
 * Pure Code 128 encoder (subset B only: ASCII 32-126) that renders an SVG made
 * of <rect> bars. No text and no external dependency, so it can be used on the
 * server (label endpoint) and in tests.
 *
 * Symbol layout: start B (104), one value per character (code point - 32), a
 * modulo-103 checksum and the stop pattern. Checksum = (104 + sum(position *
 * value)) mod 103, where position starts at 1 for the first data character.
 */

// Bar/space widths (bar, space, bar, space, bar, space) for symbol values 0-106.
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232"
] as const;
const STOP_PATTERN = "2331112";
const START_B = 104;
export const CODE128_QUIET_ZONE_MODULES = 10;

export interface Code128Symbol {
  /** Symbol values including start, data, checksum and stop (stop = 106). */
  values: number[];
  checksum: number;
  /** Alternating bar/space widths in modules, starting with a bar. */
  widths: number[];
  modules: number;
}

export function code128Checksum(values: readonly number[]): number {
  return values.reduce((sum, value, index) => sum + value * (index + 1), START_B) % 103;
}

export function encodeCode128B(text: string): Code128Symbol {
  if (text.length === 0) throw new RangeError("Code 128: texto vazio.");
  const data = [...text].map((char) => {
    const code = char.codePointAt(0) as number;
    if (code < 32 || code > 126) throw new RangeError(`Code 128: caractere fora do subconjunto B (${JSON.stringify(char)}).`);
    return code - 32;
  });
  const checksum = code128Checksum(data);
  const values = [START_B, ...data, checksum, 106];
  const widths = values.flatMap((value) => (value === 106 ? STOP_PATTERN : PATTERNS[value]).split("").map(Number));
  return { values, checksum, widths, modules: widths.reduce((sum, width) => sum + width, 0) };
}

/** Renders the symbol as an SVG with one <rect> per bar and a quiet zone on both sides. */
export function code128Svg(text: string, options: { moduleWidth?: number; height?: number } = {}): string {
  const { widths, modules } = encodeCode128B(text);
  const moduleWidth = options.moduleWidth ?? 1;
  const height = options.height ?? 40;
  const totalModules = modules + CODE128_QUIET_ZONE_MODULES * 2;
  const rects: string[] = [];
  let cursor = CODE128_QUIET_ZONE_MODULES;
  widths.forEach((width, index) => {
    if (index % 2 === 0) rects.push(`<rect x="${cursor * moduleWidth}" y="0" width="${width * moduleWidth}" height="${height}"/>`);
    cursor += width;
  });
  const svgWidth = totalModules * moduleWidth;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${height}" width="${svgWidth}" height="${height}" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="Código de barras Code 128"><rect x="0" y="0" width="${svgWidth}" height="${height}" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`;
}
