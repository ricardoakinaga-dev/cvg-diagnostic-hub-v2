/** Hospital wall-clock time is independent of the device timezone. Stored timestamps stay UTC. */
export const DEFAULT_HOSPITAL_TIMEZONE = "America/Sao_Paulo";

export function hospitalTimezone(candidate = process.env.NEXT_PUBLIC_HOSPITAL_TIMEZONE): string {
  const timezone = candidate?.trim() || DEFAULT_HOSPITAL_TIMEZONE;
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0); return timezone; }
  catch { return DEFAULT_HOSPITAL_TIMEZONE; }
}

function parts(value: Date, timezone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(value).map((part) => [part.type, part.value]));
}

export function hospitalDateKey(value: Date | string, timezone = hospitalTimezone()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const p = parts(date, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function formatHospitalDateTime(value: string | null | undefined, timezone = hospitalTimezone()): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Não informado";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: timezone, dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

export function formatHospitalDate(value: string | null | undefined, timezone = hospitalTimezone()): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Não informado";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: timezone, dateStyle: "short" }).format(new Date(value));
}

export function hospitalDateTimeInput(value: string, timezone = hospitalTimezone()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const p = parts(date, timezone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Interpret datetime-local in the institutional timezone; never normalize a DST gap/overlap silently. */
export function hospitalDateTimeInputToIso(value: string, timezone = hospitalTimezone()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error("Informe uma data e hora válidas no horário do hospital.");
  const [, y, m, d, h, min, s = "00"] = match;
  const civil = new Date(0);
  civil.setUTCFullYear(Number(y), Number(m) - 1, Number(d));
  civil.setUTCHours(Number(h), Number(min), Number(s), 0);
  const desired = `${y}-${m}-${d}T${h}:${min}:${s}`;
  if (Number(y) < 1 || civil.toISOString().slice(0, 19) !== desired) throw new Error("Informe uma data e hora válidas no horário do hospital.");
  const offsets = new Set<number>();
  // Both sides of a timezone transition are considered, including non-hour offsets.
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = new Date(civil.getTime() + hours * 3_600_000);
    const p = parts(probe, timezone);
    const localAsUtc = new Date(0);
    localAsUtc.setUTCFullYear(Number(p.year), Number(p.month) - 1, Number(p.day));
    localAsUtc.setUTCHours(Number(p.hour), Number(p.minute), Number(p.second), 0);
    offsets.add(localAsUtc.getTime() - probe.getTime());
  }
  const candidates = [...offsets].map((offset) => new Date(civil.getTime() - offset)).filter((date) => {
    const p = parts(date, timezone);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` === desired;
  });
  if (candidates.length !== 1) throw new Error(candidates.length === 0 ? "Este horário não existe no fuso do hospital. Escolha outro horário." : "Este horário é ambíguo no fuso do hospital. Escolha um horário fora da mudança de fuso.");
  return candidates[0].toISOString();
}
