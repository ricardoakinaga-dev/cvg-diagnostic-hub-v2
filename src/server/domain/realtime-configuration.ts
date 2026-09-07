export type RealtimeNotificationAdapterName = "process-local" | "postgres-listen";

export type RealtimeConfigurationEnvironment = Readonly<Record<string, string | undefined>>;

const DEFAULT_POSTGRES_REALTIME_CHANNEL = "cvg_realtime_wakeup";
const MAX_POSTGRES_REALTIME_CHANNEL_LENGTH = 63;

export function configuredRealtimeNotificationAdapter(
  environment: RealtimeConfigurationEnvironment
): RealtimeNotificationAdapterName | undefined {
  const configured = environment.REALTIME_NOTIFICATION_ADAPTER?.trim().toLowerCase();
  if (!configured) return environment.NODE_ENV === "production" ? "postgres-listen" : "process-local";
  if (configured === "process-local" || configured === "postgres-listen") return configured;
  return undefined;
}

export function realtimeNotificationChannel(
  environment: RealtimeConfigurationEnvironment
): string | undefined {
  const channel = environment.REALTIME_NOTIFICATION_CHANNEL?.trim() || DEFAULT_POSTGRES_REALTIME_CHANNEL;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(channel) || channel.length > MAX_POSTGRES_REALTIME_CHANNEL_LENGTH) return undefined;
  return channel;
}

export function isPostgresConnectionString(databaseUrl: string | undefined): boolean {
  if (!databaseUrl) return false;
  try {
    const parsed = new URL(databaseUrl.trim());
    return parsed.protocol === "postgres:" || parsed.protocol === "postgresql:";
  } catch {
    return false;
  }
}

/**
 * Validates the wake-up configuration before a production process is marked
 * ready. The durable outbox/polling path remains authoritative, but a
 * production PostgreSQL deployment must not silently advertise a process-local
 * fan-out seam between instances.
 */
export function assertRealtimeNotificationConfiguration(
  environment: RealtimeConfigurationEnvironment = process.env
): RealtimeNotificationAdapterName {
  const configured = configuredRealtimeNotificationAdapter(environment);
  if (!configured) throw new Error("REALTIME_NOTIFICATION_ADAPTER deve ser process-local ou postgres-listen.");
  if (configured === "process-local") {
    if (environment.NODE_ENV === "production") {
      throw new Error("REALTIME_NOTIFICATION_ADAPTER=process-local não é permitido em produção.");
    }
    return configured;
  }
  if (!environment.DATABASE_URL?.trim() || !isPostgresConnectionString(environment.DATABASE_URL)) {
    throw new Error("DATABASE_URL é obrigatório e deve ser uma URL PostgreSQL quando REALTIME_NOTIFICATION_ADAPTER=postgres-listen.");
  }
  if (!realtimeNotificationChannel(environment)) {
    throw new Error("REALTIME_NOTIFICATION_CHANNEL deve ser um identificador PostgreSQL válido de até 63 caracteres.");
  }
  return configured;
}
