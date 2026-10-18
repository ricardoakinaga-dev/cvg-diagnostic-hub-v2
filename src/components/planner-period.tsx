"use client";

import { useState } from "react";
import { hospitalDateTimeInput, hospitalDateTimeInputToIso } from "@/lib/hospital-time";

export function defaultPlannerPeriod() {
  const from = new Date(); const to = new Date(from.getTime() + 7 * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}
export function PlannerPeriodFields({ value, onChange }: { value: { from: string; to: string }; onChange: (value: { from: string; to: string }) => void }) {
  const [error, setError] = useState("");
  function change(field: "from" | "to", input: string) {
    if (!input) return;
    try { onChange({ ...value, [field]: hospitalDateTimeInputToIso(input) }); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Informe um horário válido para o hospital."); }
  }
  return <fieldset><legend>Período · horário do hospital</legend><label>Período de<input type="datetime-local" required value={hospitalDateTimeInput(value.from)} onChange={(event) => change("from", event.target.value)} /></label><label>Período até<input type="datetime-local" required value={hospitalDateTimeInput(value.to)} onChange={(event) => change("to", event.target.value)} /></label>{error && <p role="alert">{error}</p>}</fieldset>;
}
