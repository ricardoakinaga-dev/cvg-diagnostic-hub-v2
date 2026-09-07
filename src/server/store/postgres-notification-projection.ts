import type { PoolClient } from "pg";
import type { StoreState } from "../domain/models";

/**
 * Keeps the default JSONB-authority runtime compatible with the durable
 * relational notification-delivery sink. This is intentionally a narrow
 * delivery seam, not the clinical relational cutover.
 */
export async function projectDurableNotificationRows(
  client: PoolClient,
  before: StoreState,
  after: StoreState
): Promise<void> {
  const previousNotifications = new Map(before.notifications.map((notification) => [notification.id, notification]));
  for (const notification of after.notifications) {
    const previous = previousNotifications.get(notification.id);
    if (previous && JSON.stringify(previous) === JSON.stringify(notification)) continue;

    const recipient = after.users.find((user) => user.id === notification.recipientUserId);
    if (!recipient) throw new Error(`POSTGRES_NOTIFICATION_RECIPIENT_MISSING:${notification.id}`);
    await projectDurableNotificationUser(client, recipient);
    if (notification.acknowledgedBy) {
      const acknowledgedBy = after.users.find((user) => user.id === notification.acknowledgedBy);
      if (!acknowledgedBy) throw new Error(`POSTGRES_NOTIFICATION_ACKNOWLEDGED_BY_MISSING:${notification.id}`);
      await projectDurableNotificationUser(client, acknowledgedBy);
    }

    const values = [
      notification.id,
      notification.category,
      notification.priority,
      notification.recipientUserId,
      notification.entityType,
      notification.entityId,
      notification.deepLink,
      notification.title,
      notification.body,
      notification.dedupeKey,
      notification.state,
      notification.createdAt,
      notification.acknowledgedAt ?? null,
      notification.acknowledgedBy ?? null,
      notification.attempts,
      notification.version
    ] as const;
    if (!previous) {
      const inserted = await client.query(
        "INSERT INTO notifications (id, category, priority, recipient_user_id, entity_type, entity_id, deep_link, title, body, dedupe_key, state, created_at, acknowledged_at, acknowledged_by, attempts, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (id) DO NOTHING RETURNING id",
        [...values]
      );
      if (inserted.rowCount !== 1) throw new Error(`POSTGRES_NOTIFICATION_PROJECTION_DIVERGED:${notification.id}`);
      continue;
    }

    const updated = await client.query(
      "UPDATE notifications SET category = $2, priority = $3, recipient_user_id = $4, entity_type = $5, entity_id = $6, deep_link = $7, title = $8, body = $9, dedupe_key = $10, state = $11, acknowledged_at = $12, acknowledged_by = $13, attempts = $14, version = $15 WHERE id = $1 AND version = $16 RETURNING id",
      [...values.slice(0, 11), ...values.slice(12), previous.version]
    );
    if (updated.rowCount !== 1) throw new Error(`POSTGRES_NOTIFICATION_PROJECTION_DIVERGED:${notification.id}`);
  }
}

async function projectDurableNotificationUser(client: PoolClient, user: StoreState["users"][number]): Promise<void> {
  const result = await client.query(
    "INSERT INTO users (id, email, display_name, password_hash, timezone, active, created_at, updated_at, version) VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,$8) ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, password_hash = EXCLUDED.password_hash, timezone = EXCLUDED.timezone, active = EXCLUDED.active, version = EXCLUDED.version, updated_at = CURRENT_TIMESTAMP RETURNING id",
    [user.id, user.email, user.displayName, user.passwordHash, user.timezone, user.active !== false, user.createdAt, user.version]
  );
  if (result.rowCount !== 1) throw new Error(`POSTGRES_NOTIFICATION_USER_PROJECTION_DIVERGED:${user.id}`);
}
