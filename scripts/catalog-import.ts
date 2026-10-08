import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogImportResult } from "../src/server/application/service-types";
import type { CatalogImportRow } from "../src/server/application/service-types";

export interface CatalogImportArgs { services: string; analytes?: string; apply: boolean; actor: string }

export const CATALOG_IMPORT_USAGE = "Uso: npm run catalog:import -- --services <exames.csv> [--analytes <analitos.csv>] [--apply] --actor <email>\n"
  + "  Sem --apply a execução é apenas uma validação (nada é gravado).";

/** Pure argument parser: throws an Error with a Portuguese message on any misuse. */
export function parseCatalogImportArgs(argv: readonly string[]): CatalogImportArgs {
  let services: string | undefined;
  let analytes: string | undefined;
  let actor: string | undefined;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`O argumento ${flag} exige um valor.\n${CATALOG_IMPORT_USAGE}`);
      index += 1;
      return next;
    };
    if (flag === "--apply") apply = true;
    else if (flag === "--services") services = value();
    else if (flag === "--analytes") analytes = value();
    else if (flag === "--actor") actor = value();
    else throw new Error(`Argumento desconhecido: ${flag}\n${CATALOG_IMPORT_USAGE}`);
  }
  if (!services) throw new Error(`Informe a planilha de exames com --services.\n${CATALOG_IMPORT_USAGE}`);
  if (!actor || !actor.includes("@")) throw new Error(`Informe o e-mail do responsável com --actor.\n${CATALOG_IMPORT_USAGE}`);
  return { services, ...(analytes ? { analytes } : {}), apply, actor: actor.trim().toLowerCase() };
}

const ACTION_LABELS: Record<CatalogImportRow["action"], string> = { CREATE: "CRIAR", UPDATE: "ATUALIZAR", UNCHANGED: "SEM MUDANÇA", ERROR: "ERRO" };

/** Pure formatter: a readable Portuguese table followed by the JSON summary line. */
export function formatCatalogImportReport(report: Pick<CatalogImportResult, "rows" | "summary"> & { applied?: boolean }, apply: boolean): string {
  const lines = ["Linha  Código                          Ação         Detalhes"];
  for (const row of report.rows) {
    const details = [...(row.changes ?? []), ...(row.errors ?? [])].join(" | ");
    lines.push(`${String(row.line).padEnd(6)} ${(row.code || "-").padEnd(31)} ${ACTION_LABELS[row.action].padEnd(12)} ${details}`);
  }
  const { summary } = report;
  const outcome = summary.error > 0 ? "Nada foi gravado: corrija os erros e envie novamente."
    : apply ? (report.applied === false ? "Nada foi gravado." : "Importação aplicada.")
      : "Validação concluída; nada foi gravado. Use --apply para aplicar.";
  lines.push("", outcome, JSON.stringify({ mode: apply ? "apply" : "dry-run", ...summary }));
  return lines.join("\n");
}

export const catalogImportExitCode = (report: Pick<CatalogImportResult, "summary">): number => report.summary.error > 0 ? 1 : 0;

async function main(): Promise<void> {
  const args = parseCatalogImportArgs(process.argv.slice(2));
  const [services, analytes] = await Promise.all([readFile(args.services, "utf8"), args.analytes ? readFile(args.analytes, "utf8") : undefined]);
  const { getRuntimeStoreAsync, closeRuntimeStore } = await import("../src/server/store/runtime");
  const { createApplicationService } = await import("../src/server/application/service");
  const store = await getRuntimeStoreAsync();
  try {
    const actor = (await store.readState()).users.find((user) => user.email.toLowerCase() === args.actor);
    if (!actor || !actor.active || (actor.role !== "ADMIN" && actor.role !== "MANAGER")) {
      throw new Error(`O responsável ${args.actor} precisa ser um usuário ativo com perfil ADMIN ou MANAGER.`);
    }
    let report: CatalogImportResult;
    try {
      report = await createApplicationService(store).importCatalog(actor, { services, ...(analytes === undefined ? {} : { analytes }), dryRun: !args.apply, idempotencyKey: `cli-${randomUUID()}`, correlationId: `catalog-import-${randomUUID()}` });
    } catch (error) {
      const invalid = (error as { code?: string; details?: { importReport?: CatalogImportResult } } | undefined);
      if (invalid?.code !== "CATALOG_IMPORT_INVALID" || !invalid.details?.importReport) throw error;
      report = invalid.details.importReport;
    }
    console.log(formatCatalogImportReport(report, args.apply));
    process.exitCode = catalogImportExitCode(report);
  } finally {
    await closeRuntimeStore();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Falha inesperada na importação do catálogo.");
    process.exitCode = 1;
  });
}
