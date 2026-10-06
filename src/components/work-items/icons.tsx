import type { ItemState, Priority } from "@cvg/contracts";
import { Icon, type IconName } from "@/components/ui-icons";
import { STATE_GROUP, STATE_PROGRESS } from "./model";

/**
 * Plane-style state glyph: an outlined circle filled clockwise by workflow
 * progress, a check when done, an exclamation when the item needs attention
 * and a cross when it was closed without a result.
 */
export function StateIcon({ state, size = 14 }: { state: ItemState; size?: number }) {
  const group = STATE_GROUP[state];
  const progress = STATE_PROGRESS[state];
  const color = `var(--state-${group})`;
  const r = 6;
  const center = 8;
  if (group === "completed") {
    return <svg className="state-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"><circle cx={center} cy={center} r={7} fill={color} /><path d="m5 8.2 2 2 4-4.2" fill="none" stroke="var(--surface-1)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (group === "cancelled") {
    return <svg className="state-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"><circle cx={center} cy={center} r={7} fill={color} /><path d="m5.6 5.6 4.8 4.8M10.4 5.6l-4.8 4.8" stroke="var(--surface-1)" strokeWidth="1.5" strokeLinecap="round" /></svg>;
  }
  if (group === "attention") {
    return <svg className="state-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"><circle cx={center} cy={center} r={6.75} fill="none" stroke={color} strokeWidth="1.5" /><path d="M8 4.8v3.6M8 10.9v.1" stroke={color} strokeWidth="1.7" strokeLinecap="round" /></svg>;
  }
  if (state === "REQUESTED") {
    return <svg className="state-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"><circle cx={center} cy={center} r={6.75} fill="none" stroke={color} strokeWidth="1.5" /></svg>;
  }
  const angle = progress * Math.PI * 2;
  const x = center + r * 0.62 * Math.sin(angle);
  const y = center - r * 0.62 * Math.cos(angle);
  const large = progress > 0.5 ? 1 : 0;
  const inner = r * 0.62;
  const wedge = progress >= 0.999 ? `M ${center} ${center - inner} A ${inner} ${inner} 0 1 1 ${center - 0.01} ${center - inner} Z` : `M ${center} ${center} L ${center} ${center - inner} A ${inner} ${inner} 0 ${large} 1 ${x} ${y} Z`;
  return <svg className="state-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"><circle cx={center} cy={center} r={6.75} fill="none" stroke={color} strokeWidth="1.5" />{progress > 0 && <path d={wedge} fill={color} />}</svg>;
}

/** Plane's priority glyph: a red alert square for the top level, signal bars below it. */
export function PriorityIcon({ priority, size = 14 }: { priority: Priority; size?: number }) {
  if (priority === "EMERGENCY") {
    return <svg className="priority-glyph priority-glyph-emergency" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="3.5" fill="var(--priority-emergency)" /><path d="M8 4.3v4.6M8 11.4v.1" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" /></svg>;
  }
  const level = priority === "URGENT" ? 3 : 1;
  const color = priority === "URGENT" ? "var(--priority-urgent)" : "var(--priority-routine)";
  return <svg className="priority-glyph" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    {[0, 1, 2].map((bar) => <rect key={bar} x={2.5 + bar * 4.2} y={11 - bar * 3.2} width="2.6" height={3.5 + bar * 3.2} rx="0.9" fill={bar < level ? color : "var(--border-strong)"} />)}
  </svg>;
}

const departmentIcons: Record<string, IconName> = { LABORATORY: "lab", RADIOLOGY: "scan", ULTRASOUND: "waves", INPATIENT: "bed" };

export function DepartmentIcon({ code, size = 14 }: { code: string; size?: number }) {
  return <span className={`department-icon department-${code.toLowerCase()}`} aria-hidden="true"><Icon name={departmentIcons[code] ?? "layers"} size={size} /></span>;
}

/** Plane-style initials avatar for people and teams. */
export function Avatar({ name, size = "sm" }: { name: string; size?: "xs" | "sm" | "md" | "lg" }) {
  const initials = name.replace(/^(Dra?\.|Técnica|Equipe)\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return <span className={`avatar-chip avatar-${size}`} style={{ "--avatar-hue": hash % 360 } as React.CSSProperties} aria-hidden="true">{initials || "?"}</span>;
}
