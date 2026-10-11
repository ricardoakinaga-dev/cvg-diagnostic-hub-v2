import "./load-file-secrets";
// ONLY the disposable full-restore drill: exercise a deletion after the object reached the write-once off-site copy.
import { closeRuntimeStore, getRuntimeFileStore, getRuntimeStoreAsync } from "../src/server/store/runtime";

async function main(): Promise<void> {
  const project = process.env.DRILL_PROJECT ?? "";
  const batch = process.env.DRILL_BATCH ?? "";
  const count = Number(process.env.DRILL_ATTACHMENT_COUNT);
  if (!/^[a-z0-9][a-z0-9_-]*drill[a-z0-9_-]*$/.test(project) || !/^\d{14}$/.test(batch) || !Number.isSafeInteger(count) || count < 2) {
    throw new Error("Exclusão permitida somente no projeto descartável do drill, com batch e contagem válidos.");
  }
  try {
    const store = await getRuntimeStoreAsync();
    const id = `attachment-drill-${batch}-${count}`;
    const expectedKey = `attachments/drill-${batch}/${count}.bin`;
    await store.transaction(state => {
      const attachment = state.attachments.find(row => row.id === id);
      if (!attachment || attachment.storageKey !== expectedKey) throw new Error("Anexo sintético esperado não encontrado: exclusão bloqueada.");
      return { state: { ...state, attachments: state.attachments.filter(row => row.id !== id) }, result: undefined };
    });
    await getRuntimeFileStore().remove(expectedKey);
    console.log(JSON.stringify({ event: "drill.attachment_deleted", lastWriteAt: new Date().toISOString() }));
  } finally {
    await closeRuntimeStore();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "drill.delete_error", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 2;
});
