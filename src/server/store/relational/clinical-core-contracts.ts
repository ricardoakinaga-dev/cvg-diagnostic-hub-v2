import type { StoreState } from "../../domain/models";

export interface RelationalSqlClient {
  query(text: string, values?: unknown[]): Promise<RelationalSqlResult>;
}

export interface RelationalSqlResult {
  readonly rows: readonly unknown[];
  readonly rowCount?: number | null;
}

export interface RelationalClinicalCoreReadinessOptions {
  /**
   * A legacy deployment may still have the additive sample-membership check
   * unvalidated while the explicit shadow backfill is repairing its rows.
   * Every other relational invariant remains required.
   */
  readonly allowUnvalidatedSampleMembership?: boolean;
}

export interface RelationalClinicalRequestRead {
  readonly request: Readonly<Record<string, unknown>>;
  readonly items: readonly Readonly<Record<string, unknown>>[];
  readonly samples: readonly Readonly<Record<string, unknown>>[];
  readonly sampleItemLinks: readonly Readonly<Record<string, unknown>>[];
  readonly procedures: readonly Readonly<Record<string, unknown>>[];
  readonly schedules: readonly Readonly<Record<string, unknown>>[];
  readonly results: readonly Readonly<Record<string, unknown>>[];
  readonly resultVersions: readonly Readonly<Record<string, unknown>>[];
  readonly attachments: readonly Readonly<Record<string, unknown>>[];
  readonly notifications: readonly Readonly<Record<string, unknown>>[];
}

export interface RelationalClinicalCoreRuntime {
  assertReady(client: RelationalSqlClient, options?: RelationalClinicalCoreReadinessOptions): Promise<void>;
  repairSampleMembership(client: RelationalSqlClient, state: StoreState): Promise<void>;
  validateSampleMembership(client: RelationalSqlClient): Promise<void>;
  readRequest(client: RelationalSqlClient, requestId: string): Promise<RelationalClinicalRequestRead | undefined>;
  projectStateDelta(client: RelationalSqlClient, before: StoreState, after: StoreState): Promise<void>;
}
