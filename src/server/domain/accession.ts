import type { StoreState } from "./models";

/**
 * System-generated accession: <PREFIX><YYMMDD>-<NNNN><C>
 *  - PREFIX: 1-4 chars [A-Z0-9] (env ACCESSION_PREFIX, default "A").
 *  - YYMMDD: UTC date of generation.
 *  - NNNN: zero-padded per-day sequence, starting at 0001.
 *  - C: Mod-10 (Luhn) check digit over the 10 digits YYMMDD + NNNN. Starting
 *    from the rightmost payload digit, every second digit is doubled (digits of
 *    a product above 9 are summed); C = (10 - (sum mod 10)) mod 10. It catches
 *    every single-digit typo and almost every adjacent transposition. Digits
 *    inside the prefix are not part of the payload.
 */
export const ACCESSION_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,39}$/;
const GENERATED_PATTERN = /^([A-Z0-9]{1,4})(\d{6})-(\d{4})(\d)$/;
const PREFIX_PATTERN = /^[A-Z0-9]{1,4}$/;
export const DEFAULT_ACCESSION_PREFIX = "A";
export const MAX_DAILY_SEQUENCE = 9999;

export function resolveAccessionPrefix(raw: string | undefined): string {
  const value = raw === undefined || raw.trim() === "" ? DEFAULT_ACCESSION_PREFIX : raw.trim();
  if (!PREFIX_PATTERN.test(value)) throw new Error("ACCESSION_PREFIX deve ter de 1 a 4 caracteres maiúsculos ou dígitos [A-Z0-9].");
  return value;
}

export function accessionPrefixFromEnv(environment: Partial<NodeJS.ProcessEnv> = process.env): string {
  return resolveAccessionPrefix(environment.ACCESSION_PREFIX);
}

export function mod10CheckDigit(payload: string): string {
  let sum = 0;
  [...payload].reverse().forEach((char, index) => {
    const digit = Number(char);
    const value = index % 2 === 0 ? digit * 2 : digit;
    sum += value > 9 ? value - 9 : value;
  });
  return String((10 - (sum % 10)) % 10);
}

/** True when the code has the generated shape <PREFIX><YYMMDD>-<NNNN><C>. */
export function isGeneratedAccessionFormat(code: string): boolean {
  return GENERATED_PATTERN.test(code);
}

/**
 * Validates the check character of a generated-format code. Codes that do not
 * have the generated shape (legacy hand-typed accessions) return false; callers
 * decide whether such codes are acceptable.
 */
export function validateAccessionCheckCharacter(code: string): boolean {
  const match = GENERATED_PATTERN.exec(code);
  return match !== null && mod10CheckDigit(`${match[2]}${match[3]}`) === match[4];
}

function datePart(now: Date | string): string {
  const date = typeof now === "string" ? new Date(now) : now;
  if (Number.isNaN(date.getTime())) throw new RangeError("Data inválida para gerar o accession.");
  return date.toISOString().slice(2, 10).replace(/-/g, "");
}

/** Generates `count` consecutive accessions for the UTC day of `now` with a single scan of the samples. */
export function generateAccessionCodes(state: Pick<StoreState, "samples">, now: Date | string, prefix: string, count: number): string[] {
  const safePrefix = resolveAccessionPrefix(prefix);
  const day = datePart(now);
  const head = `${safePrefix}${day}-`;
  let max = 0;
  for (const sample of state.samples) {
    const code = sample.accessionCode;
    if (code.length !== head.length + 5 || !code.startsWith(head) || !validateAccessionCheckCharacter(code)) continue;
    max = Math.max(max, Number(code.slice(head.length, head.length + 4)));
  }
  if (max + count > MAX_DAILY_SEQUENCE) throw new RangeError("Limite diário de accessions gerados excedido.");
  return Array.from({ length: count }, (_, index) => {
    const sequence = String(max + index + 1).padStart(4, "0");
    return `${head}${sequence}${mod10CheckDigit(`${day}${sequence}`)}`;
  });
}

export function generateAccessionCode(state: Pick<StoreState, "samples">, now: Date | string, prefix: string): string {
  return generateAccessionCodes(state, now, prefix, 1)[0];
}
