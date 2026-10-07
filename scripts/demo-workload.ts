/**
 * Populates a LOCAL development instance with a realistic, fully synthetic
 * workload through the public HTTP API, so every record passes the same
 * domain rules, authorization and audit as real use.
 *
 *   ALLOW_SYNTHETIC_SEED=true DEMO_PASSWORD=... npx tsx scripts/demo-workload.ts [baseUrl]
 *
 * Refuses to run unless ALLOW_SYNTHETIC_SEED=true and the target is loopback.
 */
import { randomUUID } from "node:crypto";

const baseUrl = (process.argv[2] ?? process.env.APP_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
const password = process.env.DEMO_PASSWORD;

if (process.env.ALLOW_SYNTHETIC_SEED !== "true") throw new Error("Defina ALLOW_SYNTHETIC_SEED=true para gerar dados sintéticos.");
if (!password) throw new Error("Defina DEMO_PASSWORD com a senha sintética dos usuários de demonstração.");
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname)) throw new Error("A carga de demonstração só roda contra uma instância local.");

type Json = Record<string, unknown>;

class Session {
  private cookies = new Map<string, string>();
  constructor(readonly label: string) {}

  private absorb(response: Response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const index = pair.indexOf("=");
      this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  async call<T = Json>(method: string, path: string, body?: Json): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", origin: baseUrl, cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; ") };
    if (body) headers["content-type"] = "application/json";
    if (method !== "GET") {
      headers["idempotency-key"] = randomUUID();
      const csrf = this.cookies.get("cvg_csrf");
      if (csrf) headers["x-csrf-token"] = csrf;
    }
    const response = await fetch(`${baseUrl}/api/v1${path}`, { method, headers, redirect: "error", body: body ? JSON.stringify(body) : undefined });
    this.absorb(response);
    const payload = await response.json().catch(() => ({})) as { data?: T; error?: { code?: string; message?: string } };
    if (!response.ok) throw new Error(`${this.label} ${method} ${path} → ${response.status} ${payload.error?.code ?? ""} ${payload.error?.message ?? ""}`);
    return payload.data as T;
  }

  static async login(email: string): Promise<Session> {
    const session = new Session(email.split("@")[0]);
    await session.call("POST", "/session/login", { email, password });
    return session;
  }
}

interface Item { id: string; status: string; version: number; workflowType: string; currentResultId?: string; currentSampleId?: string }

const patients = [
  ["Luna", "Felino", "SRD", "Fêmea", "M. Andrade"], ["Bob", "Canino", "Golden Retriever", "Macho", "C. Ribeiro"],
  ["Nina", "Canino", "Shih Tzu", "Fêmea", "P. Souza"], ["Max", "Canino", "Pastor Alemão", "Macho", "R. Lima"],
  ["Lola", "Felino", "Persa", "Fêmea", "J. Martins"], ["Fred", "Canino", "Beagle", "Macho", "L. Costa"],
  ["Mia", "Felino", "Siamês", "Fêmea", "A. Pereira"], ["Rex", "Canino", "Rottweiler", "Macho", "F. Almeida"],
  ["Pipoca", "Canino", "Poodle", "Fêmea", "T. Gomes"], ["Simba", "Felino", "Maine Coon", "Macho", "D. Carvalho"],
  ["Belinha", "Canino", "Dachshund", "Fêmea", "S. Rocha"], ["Toby", "Canino", "Border Collie", "Macho", "G. Teixeira"],
  ["Amora", "Felino", "SRD", "Fêmea", "V. Mendes"], ["Zeca", "Canino", "Bulldog Francês", "Macho", "H. Barros"]
] as const;

// [patient index, priority, services, how far each item should go]
type Stage = "requested" | "received" | "processing" | "recollection" | "scheduled" | "running" | "awaiting" | "result" | "reviewed" | "cancelled";
const plan: Array<[number, "ROUTINE" | "URGENT" | "EMERGENCY", Array<[string, Stage]>]> = [
  [0, "EMERGENCY", [["service-hemogram", "processing"], ["service-crp", "received"], ["service-xray", "result"]]],
  [1, "URGENT", [["service-ultrasound", "scheduled"], ["service-hemogram", "requested"]]],
  [2, "ROUTINE", [["service-hemogram", "received"], ["service-xray", "reviewed"]]],
  [3, "URGENT", [["service-xray", "running"], ["service-crp", "requested"]]],
  [4, "ROUTINE", [["service-ultrasound", "awaiting"]]],
  [5, "EMERGENCY", [["service-xray", "awaiting"], ["service-hemogram", "recollection"]]],
  [6, "ROUTINE", [["service-ultrasound", "result"], ["service-crp", "processing"]]],
  [7, "URGENT", [["service-hemogram", "requested"], ["service-ultrasound", "requested"]]],
  [8, "ROUTINE", [["service-crp", "cancelled"], ["service-xray", "requested"]]],
  [9, "ROUTINE", [["service-ultrasound", "reviewed"]]],
  [10, "URGENT", [["service-hemogram", "processing"], ["service-xray", "scheduled"]]],
  [11, "ROUTINE", [["service-ultrasound", "running"], ["service-crp", "requested"]]],
  [12, "EMERGENCY", [["service-hemogram", "received"], ["service-ultrasound", "scheduled"]]],
  [13, "ROUTINE", [["service-xray", "result"], ["service-hemogram", "requested"]]]
];

const narratives: Record<string, string> = {
  RADIOLOGY: "Campos pulmonares com padrão intersticial discreto em lobos caudais. Silhueta cardíaca dentro dos limites. Sem efusão pleural.",
  ULTRASOUND: "Fígado com dimensões e ecogenicidade preservadas. Rins com relação corticomedular mantida. Vesícula urinária com conteúdo anecoico."
};

async function main() {
  const vet = await Session.login("vet@cvg.local");
  const lab = await Session.login("lab@cvg.local");
  const rx = await Session.login("rx@cvg.local");
  const us = await Session.login("us@cvg.local");
  const tech: Record<string, Session> = { LABORATORY: lab, RADIOLOGY: rx, ULTRASOUND: us };
  const reasons = await vet.call<Array<{ type: string; code: string; active: boolean }>>("GET", "/clinical-reasons");
  const cancelReason = reasons.find((reason) => reason.type === "CANCEL" && reason.active)?.code;
  const recollectionReason = (await lab.call<Array<{ type: string; code: string; active: boolean }>>("GET", "/clinical-reasons")).find((reason) => reason.type === "RECOLLECTION" && reason.active)?.code;
  let slot = 0;
  let accession = Date.now() % 100000;

  const read = async (session: Session, id: string) => (await session.call<{ item: Item }>("GET", `/diagnostic-items/${id}`)).item;

  async function advance(item: Item, stage: Stage) {
    const owner = tech[item.workflowType];
    let current = await read(owner, item.id);
    const step = async (path: string, body: Json = {}, session = owner) => {
      await session.call("POST", path, { ...body, expectedVersion: current.version });
      current = await read(owner, item.id);
    };
    if (stage === "requested") return;
    if (stage === "cancelled") { if (cancelReason) await vet.call("POST", `/diagnostic-items/${item.id}/cancel`, { reasonCode: cancelReason, reason: "Conduta clínica alterada", expectedVersion: current.version }); return; }
    if (item.workflowType === "LABORATORY") {
      await step(`/diagnostic-items/${item.id}/receive-sample`, { accessionCode: `ACC-DEMO-${accession++}`, sampleType: "EDTA" });
      if (stage === "received") return;
      await step(`/diagnostic-items/${item.id}/start-processing`);
      if (stage === "recollection" && recollectionReason) { await step(`/diagnostic-items/${item.id}/request-recollection`, { reasonCode: recollectionReason, note: "Amostra hemolisada" }); }
      return;
    }
    if (item.workflowType === "ULTRASOUND" || stage === "scheduled") {
      const start = new Date(Date.now() + (2 + slot++) * 60 * 60 * 1000);
      await step(`/diagnostic-items/${item.id}/schedule`, { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 40 * 60 * 1000).toISOString(), resource: item.workflowType === "ULTRASOUND" ? `US-0${(slot % 2) + 1}` : `RX-0${(slot % 2) + 1}` });
      if (stage === "scheduled") return;
    }
    await step(`/diagnostic-items/${item.id}/start-procedure`);
    if (stage === "running") return;
    await step(`/diagnostic-items/${item.id}/mark-performed`);
    if (stage === "awaiting") return;
    const draft = await owner.call<{ result: { id: string; version: number } }>("POST", `/diagnostic-items/${item.id}/results`, { narrative: narratives[item.workflowType] ?? "Exame sem alterações significativas.", content: {}, expectedVersion: current.version });
    await owner.call("POST", `/results/${draft.result.id}/release`, { expectedVersion: draft.result.version });
    if (stage === "result") return;
    type ResultRead = { item: { version: number }; version: { id: string } };
    const released = await vet.call<ResultRead>("GET", `/results/${draft.result.id}`);
    await vet.call("POST", `/results/${draft.result.id}/view`, { versionId: released.version.id, expectedVersion: released.item.version });
    const viewed = await vet.call<ResultRead>("GET", `/results/${draft.result.id}`);
    await vet.call("POST", `/results/${draft.result.id}/review`, { versionId: viewed.version.id, expectedVersion: viewed.item.version });
  }

  let created = 0;
  let createdPatients = 0;
  let stageFailures = 0;
  for (const [patientIndex, priority, services] of plan) {
    const [displayName, species, breed, sex, ownerLabel] = patients[patientIndex];
    const existing = await vet.call<Array<{ displayName: string }>>("GET", `/patients?q=${encodeURIComponent(displayName)}`);
    if (existing.some((patient) => patient.displayName === displayName)) { console.log(`· ${displayName}: já existe, mantido`); continue; }
    const inpatient = patientIndex % 3 !== 0;
    const registration = await vet.call<{ patient: { id: string }; encounter: { id: string } }>("POST", "/patients", { displayName, species, breed, sex, ownerLabel, encounterType: inpatient ? "INPATIENT" : "EMERGENCY", ...(inpatient ? { ward: patientIndex % 2 ? "Internação A" : "Internação B", bed: `L-${String(patientIndex + 1).padStart(2, "0")}` } : {}) });
    const request = await vet.call<{ id: string; items: Item[] }>("POST", "/diagnostic-requests", { patientId: registration.patient.id, encounterId: registration.encounter.id, priority, items: services.map(([serviceId]) => ({ serviceId })) });
    createdPatients++;
    let patientFailures = 0;
    for (const [index, item] of request.items.entries()) {
      try { await advance(item, services[index][1]); }
      catch (cause) { patientFailures++; stageFailures++; console.warn(`  ! ${displayName}: ${(cause as Error).message}`); }
    }
    created += request.items.length;
    console.log(`${patientFailures ? "!" : "✓"} ${displayName}: ${patientFailures ? `${patientFailures} avanço(s) não concluído(s)` : services.map(([, stage]) => stage).join(", ")}`);
  }
  console.log(`Carga sintética aplicada: ${createdPatients} pacientes novos, ${created} exames novos, ${stageFailures} falhas de avanço.`);
  if (stageFailures > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
