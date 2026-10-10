import "./load-file-secrets";
// Used ONLY by scripts/outage-drill.sh on a disposable Compose project: queues one in-app notification delivery through
// the application's store (the same transactional outbox path a released result uses) while the worker is stopped, so
// the outbox age grows and CvgOutboxStalled can be observed. Prints one JSON line.
import { createOutbox, notificationFor } from "../src/server/application/service-common";
import { getRuntimeStoreAsync } from "../src/server/store/runtime";

async function main(): Promise<void> {
  const store = await getRuntimeStoreAsync();
  const batch = process.env.DRILL_BATCH ?? new Date().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14);
  const dedupeKey = `drill:${batch}`;
  const queuedAt = await store.transaction((state) => {
    // The delivery projection requires a real recipient: the first administrator created by the bootstrap.
    const recipient = state.users.find((user) => user.id === process.env.DRILL_RECIPIENT_USER_ID) ?? state.users.find((user) => user.role === "ADMIN" && user.active !== false) ?? state.users[0];
    if (!recipient) throw new Error("DRILL_NO_RECIPIENT: nenhum usuário no estado; rode o bootstrap antes.");
    const recipientUserId = recipient.id;
    let next = notificationFor(state, {
      category: "INFORMATIONAL", priority: "NORMAL", recipientUserId, entityType: "REQUEST", entityId: `request-drill-${batch}`,
      deepLink: "/notifications", title: "Ensaio de indisponibilidade", body: "Mensagem sintética do ensaio do worker.", dedupeKey
    });
    const notification = next.notifications.find((entry) => entry.dedupeKey === dedupeKey && entry.recipientUserId === recipientUserId)!;
    const outbox = createOutbox("DrillNotificationRequested", "Notification", notification.id, `corr-drill-${batch}`, { notificationId: notification.id });
    next = { ...next, outbox: [...next.outbox, outbox] };
    return { state: next, result: outbox.availableAt };
  });
  console.log(JSON.stringify({ event: "drill.outbox_seeded", batch, queuedAt }));
  await (store as { close?: () => Promise<void> }).close?.();
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "drill.seed_error", message: error instanceof Error ? error.message : String(error) }));
  process.exit(2);
});
