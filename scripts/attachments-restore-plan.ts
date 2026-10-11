import "./load-file-secrets";
// Read-only. Stop app and worker; connect to the recovered database and select only its referenced objects from the
// downloaded off-site evidence. The files-from list and the evidence inventory are private files. Nothing is deleted.
// tsx scripts/attachments-restore-plan.ts --source /restore/offsite/objects --output /restore/objects.list --report /restore/objects-plan.json
import { lstat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { planAttachmentRestore } from "../src/server/storage/attachments-restore-plan";
import { closeRuntimeStore, getRuntimeStoreAsync } from "../src/server/store/runtime";
import { archivedAttachmentReferences } from "./attachment-references";
import { verifySelectedAttachmentBytes } from "./attachment-bytes";

async function objectKeys(directory: string, prefix = ""): Promise<string[]> {
  const keys: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("A cópia de evidências não pode conter links simbólicos.");
    if (entry.isDirectory()) keys.push(...await objectKeys(path.join(directory, entry.name), key));
    else if (entry.isFile()) keys.push(key);
    else throw new Error("Tipo de arquivo inválido na cópia de evidências.");
  }
  return keys;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--source" || args[2] !== "--output" || args[4] !== "--report") {
    throw new Error("Uso: attachments-restore-plan.ts --source DIR --output LIST --report JSON");
  }
  const [source, output, report] = [args[1], args[3], args[5]].map(value => path.resolve(value));
  if (output === report || [output, report].some(file => file === source || file.startsWith(`${source}${path.sep}`))) {
    throw new Error("Lista e relatório devem ser arquivos distintos fora do diretório de objetos.");
  }
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error("--source deve ser um diretório de evidências sem link simbólico.");
  if (process.env.APP_DATA_MODE !== "postgres") throw new Error("APP_DATA_MODE=postgres é obrigatório para ler o ponto recuperado.");
  try {
    const store = await getRuntimeStoreAsync();
    const state = await store.readState();
    const archived = await archivedAttachmentReferences(store);
    const plan = planAttachmentRestore(state.attachments, archived, await objectKeys(source));
    const integrity = plan.ok ? await verifySelectedAttachmentBytes(source, plan.selectedObjectKeys, [...state.attachments, ...archived]) : undefined;
    await writeFile(report, `${JSON.stringify({ ...plan, ok: plan.ok && integrity?.ok === true, integrity, checkedAt: new Date().toISOString() }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    if (!plan.ok) throw new Error("Cópia externa sem objeto finalizado ou arquivado exigido pelo banco: restauração bloqueada; consulte o relatório privado.");
    if (!integrity?.ok) throw new Error("Checksum, tamanho ou metadados dos objetos selecionados divergem do banco recuperado: restauração bloqueada; consulte o relatório privado.");
    await writeFile(output, plan.selectedObjectKeys.length ? `${plan.selectedObjectKeys.join("\n")}\n` : "", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ event: "attachments.restore_planned", selectedObjects: plan.selectedObjectKeys.length,
      retainedEvidenceObjects: plan.excludedObjectKeys.length, missingObjects: plan.missingObjects.length, verifiedObjects: integrity.verifiedObjects }));
  } finally {
    await closeRuntimeStore();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "attachments.restore_plan_error", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 2;
});
