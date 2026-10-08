export const DEFAULT_LABEL_WIDTH_MM = 50;
export const DEFAULT_LABEL_HEIGHT_MM = 30;
export const MIN_LABEL_MM = 20;
export const MAX_LABEL_MM = 150;

function dimension(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < MIN_LABEL_MM || value > MAX_LABEL_MM) {
    throw new Error(`${name} deve estar entre ${MIN_LABEL_MM} e ${MAX_LABEL_MM} mm.`);
  }
  return value;
}

/** Label size in millimetres from LABEL_WIDTH_MM / LABEL_HEIGHT_MM (defaults 50 x 30, valid range 20-150). */
export function labelDimensionsFromEnv(environment: Partial<NodeJS.ProcessEnv> = process.env): { widthMm: number; heightMm: number } {
  return {
    widthMm: dimension("LABEL_WIDTH_MM", environment.LABEL_WIDTH_MM, DEFAULT_LABEL_WIDTH_MM),
    heightMm: dimension("LABEL_HEIGHT_MM", environment.LABEL_HEIGHT_MM, DEFAULT_LABEL_HEIGHT_MM)
  };
}
