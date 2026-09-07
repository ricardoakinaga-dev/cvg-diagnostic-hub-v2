import { describe, expect, it, vi } from "vitest";
import type { DiagnosticItem, DiagnosticRequest, OutboxMessage } from "../../domain/models";
import { createDemoState } from "../fixtures";
import { LATEST_RUNTIME_SCHEMA_VERSION } from "../migrations";
import {
  RELATIONAL_CORE_MARKER,
  RELATIONAL_CORE_READINESS_SQL,
  RELATIONAL_REQUEST_READ_SQL,
  RELATIONAL_SAMPLE_MEMBERSHIP_VALIDATION_SQL,
  RelationalClinicalCoreAdapter,
  type RelationalSqlClient
} from "./clinical-core-adapter";

/** Unit-level adapter tests use a mocked client; live coverage is in tests/postgres/. */
describe("RelationalClinicalCoreAdapter (static/mocked)", () => {
  function client(
    implementation?: (text: string, values: readonly unknown[]) => Promise<{ rows: readonly unknown[]; rowCount?: number | null }>
  ) {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const query = vi.fn(async (text: string, values: readonly unknown[] = []) => {
      queries.push({ text, values });
      return implementation
        ? implementation(text, values)
        : { rows: [{ id: "relational-row", version: 2 }], rowCount: 1 };
    });
    return { client: { query } as RelationalSqlClient, queries, query };
  }

  function request(version = 1): DiagnosticRequest {
    return {
      id: "request-with-hyphen",
      requestCode: "EX-260904-0001",
      patientId: "patient-with-hyphen",
      encounterId: "encounter-with-hyphen",
      requesterId: "user-with-hyphen",
      requestingDepartmentCode: "INPATIENT",
      priority: "ROUTINE",
      aggregateStatus: "REQUESTED",
      itemIds: [],
      createdAt: "2026-09-04T12:00:00.000Z",
      updatedAt: "2026-09-04T12:00:00.000Z",
      version
    };
  }

  function item(version = 1): DiagnosticItem {
    return {
      id: "item-with-hyphen",
      requestId: "request-with-hyphen",
      serviceId: "service-with-hyphen",
      departmentCode: "LABORATORY",
      workflowType: "LABORATORY",
      priority: "ROUTINE",
      status: "REQUESTED",
      requestedAt: "2026-09-04T12:00:00.000Z",
      slaStartedAt: "2026-09-04T12:00:00.000Z",
      dueAt: "2026-09-04T20:00:00.000Z",
      slaPolicyVersion: 1,
      version
    };
  }

  it("fails closed unless the current relational marker, required tables, write shape, and integrity constraints are ready", async () => {
    const ready = client(async (text) => text === RELATIONAL_CORE_READINESS_SQL
      ? { rows: [{ marker_ready: true, tables_ready: true, write_shape_ready: true, constraints_ready: true }], rowCount: 1 }
      : { rows: [], rowCount: 1 });
    const adapter = new RelationalClinicalCoreAdapter();

    await expect(adapter.assertReady(ready.client)).resolves.toBeUndefined();
    expect(ready.queries[0]).toEqual(expect.objectContaining({ text: RELATIONAL_CORE_READINESS_SQL }));
    expect(ready.queries[0]?.values[0]).toBe(RELATIONAL_CORE_MARKER);
    expect(ready.queries[0]?.values[1]).toBe(LATEST_RUNTIME_SCHEMA_VERSION);
    expect(ready.queries[0]?.values[2]).toEqual(expect.arrayContaining(["diagnostic_requests", "results"]));
    expect(ready.queries[0]?.values[3]).toEqual(expect.arrayContaining([
      "results_current_version_fk",
      "samples_accession_format",
      "samples_replacement_reason_required",
      "samples_item_ids_nonempty",
      "sample_item_links_status_check",
      "notifications_recipient_dedupe_key"
    ]));
    expect(ready.queries[0]?.values[4]).toBe(false);
    expect(RELATIONAL_CORE_READINESS_SQL).toContain("constraint_info.convalidated");
    expect(RELATIONAL_CORE_READINESS_SQL).toContain("constraint_info.conrelid");
    expect(RELATIONAL_CORE_READINESS_SQL).toContain("relation_schema.nspname = current_schema()");

    const notReady = client(async (text) => text === RELATIONAL_CORE_READINESS_SQL
      ? { rows: [{ marker_ready: true, tables_ready: false, write_shape_ready: true, constraints_ready: true }], rowCount: 1 }
      : { rows: [], rowCount: 1 });
    await expect(adapter.assertReady(notReady.client)).rejects.toThrow("POSTGRES_RELATIONAL_CLINICAL_CORE_NOT_READY");
  });

  it("allows only sample membership to remain unvalidated during backfill and validates it before completion", async () => {
    const ready = client(async (text) => text === RELATIONAL_CORE_READINESS_SQL
      ? { rows: [{ marker_ready: true, tables_ready: true, write_shape_ready: true, constraints_ready: true }], rowCount: 1 }
      : { rows: [], rowCount: 1 });
    const adapter = new RelationalClinicalCoreAdapter();

    await expect(adapter.assertReady(ready.client, { allowUnvalidatedSampleMembership: true })).resolves.toBeUndefined();
    expect(ready.queries[0]?.values[4]).toBe(true);
    await expect(adapter.validateSampleMembership(ready.client)).resolves.toBeUndefined();
    expect(ready.queries.at(-1)).toEqual(expect.objectContaining({ text: RELATIONAL_SAMPLE_MEMBERSHIP_VALIDATION_SQL, values: [] }));

    const failing = client(async (text) => {
      if (text === RELATIONAL_SAMPLE_MEMBERSHIP_VALIDATION_SQL) throw new Error("legacy sample row has no item membership");
      return { rows: [], rowCount: 1 };
    });
    await expect(adapter.validateSampleMembership(failing.client)).rejects.toThrow("POSTGRES_RELATIONAL_SAMPLE_MEMBERSHIP_NOT_VALID");
  });

  it("reads a complete request aggregate in one relational statement without converting text IDs", async () => {
    const aggregate = {
      request: { id: "request-with-hyphen", request_code: "EX-260904-0001" },
      items: [{ id: "item-with-hyphen" }],
      samples: [],
      sampleItemLinks: [],
      procedures: [],
      schedules: [],
      results: [],
      resultVersions: [],
      attachments: [],
      notifications: []
    };
    const fake = client(async (text) => text === RELATIONAL_REQUEST_READ_SQL
      ? { rows: [{ aggregate }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const adapter = new RelationalClinicalCoreAdapter();

    await expect(adapter.readRequest(fake.client, "request-with-hyphen")).resolves.toEqual(aggregate);
    expect(fake.query).toHaveBeenCalledOnce();
    expect(fake.query).toHaveBeenCalledWith(RELATIONAL_REQUEST_READ_SQL, ["request-with-hyphen"]);
    expect(RELATIONAL_REQUEST_READ_SQL).not.toMatch(/::uuid/i);
  });

  it("fails closed when the relational aggregate crosses request scope or repeats an entity id", async () => {
    const scoped = client(async (text) => text === RELATIONAL_REQUEST_READ_SQL
      ? {
        rows: [{ aggregate: {
          request: { id: "request-with-hyphen" },
          items: [{ id: "item-1", request_id: "another-request" }],
          samples: [], sampleItemLinks: [], procedures: [], schedules: [], results: [], resultVersions: [], attachments: [], notifications: []
        } }], rowCount: 1
      }
      : { rows: [], rowCount: 0 });
    const adapter = new RelationalClinicalCoreAdapter();

    await expect(adapter.readRequest(scoped.client, "request-with-hyphen"))
      .rejects.toThrow("POSTGRES_RELATIONAL_READ_SCOPE_MISMATCH:items:item-1");

    const duplicate = client(async (text) => text === RELATIONAL_REQUEST_READ_SQL
      ? {
        rows: [{ aggregate: {
          request: { id: "request-with-hyphen" },
          items: [{ id: "item-1" }, { id: "item-1" }],
          samples: [], sampleItemLinks: [], procedures: [], schedules: [], results: [], resultVersions: [], attachments: [], notifications: []
        } }], rowCount: 1
      }
      : { rows: [], rowCount: 0 });
    await expect(adapter.readRequest(duplicate.client, "request-with-hyphen"))
      .rejects.toThrow("POSTGRES_RELATIONAL_READ_DUPLICATE:items:item-1");
  });

  it("fails closed when relational sample link metadata diverges from sample state", async () => {
    const aggregate = {
      request: { id: "request-with-hyphen" },
      items: [{ id: "item-with-hyphen", request_id: "request-with-hyphen", requested_at: "2026-09-04T12:00:00.000Z" }],
      samples: [{
        id: "sample-with-hyphen",
        request_id: "request-with-hyphen",
        accession_code: "ACC-READ-1",
        sample_type: "EDTA",
        status: "REPLACED",
        rejection_reason_id: "reason-hemolyzed",
        rejection_note: "Amostra hemolisada",
        item_ids: ["item-with-hyphen"],
        received_at: "2026-09-04T12:30:00.000Z",
        received_by: "user-with-hyphen",
        version: 2
      }],
      sampleItemLinks: [{
        id: "sample-item-link:sample-with-hyphen:item-with-hyphen",
        sample_id: "sample-with-hyphen",
        item_id: "item-with-hyphen",
        request_id: "request-with-hyphen",
        link_status: "ACTIVE",
        linked_at: "2026-09-04T12:30:00.000Z",
        linked_by: "user-with-hyphen",
        rejection_note: "Amostra hemolisada",
        version: 1
      }],
      procedures: [], schedules: [], results: [], resultVersions: [], attachments: [], notifications: []
    };
    const fake = client(async (text) => text === RELATIONAL_REQUEST_READ_SQL
      ? { rows: [{ aggregate }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const adapter = new RelationalClinicalCoreAdapter();

    await expect(adapter.readRequest(fake.client, "request-with-hyphen"))
      .rejects.toThrow("POSTGRES_RELATIONAL_READ_LINEAGE_MISMATCH:sample-item-link:sample-with-hyphen:item-with-hyphen:link_status");
  });

  it("fails closed on orphaned links and samples without a relational link", async () => {
    const baseAggregate = {
      request: { id: "request-with-hyphen" },
      items: [{ id: "item-with-hyphen", request_id: "request-with-hyphen", requested_at: "2026-09-04T12:00:00.000Z" }],
      samples: [],
      sampleItemLinks: [],
      procedures: [], schedules: [], results: [], resultVersions: [], attachments: [], notifications: []
    };
    const orphan = client(async (text) => text === RELATIONAL_REQUEST_READ_SQL
      ? {
        rows: [{ aggregate: {
          ...baseAggregate,
          sampleItemLinks: [{
            id: "orphan-link",
            sample_id: "missing-sample",
            item_id: "item-with-hyphen",
            request_id: "request-with-hyphen",
            link_status: "ACTIVE",
            linked_at: "2026-09-04T12:00:00.000Z",
            linked_by: null,
            rejection_note: null,
            version: 1
          }]
        } }], rowCount: 1
      }
      : { rows: [], rowCount: 0 });
    const adapter = new RelationalClinicalCoreAdapter();

    await expect(adapter.readRequest(orphan.client, "request-with-hyphen"))
      .rejects.toThrow("POSTGRES_RELATIONAL_READ_LINEAGE_MISMATCH:orphan-link:foreign_key");

    const unlinked = client(async (text) => text === RELATIONAL_REQUEST_READ_SQL
      ? {
        rows: [{ aggregate: {
          ...baseAggregate,
          samples: [{
            id: "sample-without-link",
            request_id: "request-with-hyphen",
            accession_code: "ACC-NO-LINK",
            sample_type: "EDTA",
            status: "RECEIVED",
            item_ids: ["item-with-hyphen"],
            received_at: "2026-09-04T12:30:00.000Z",
            received_by: "user-with-hyphen",
            version: 1
          }]
        } }], rowCount: 1
      }
      : { rows: [], rowCount: 0 });
    await expect(adapter.readRequest(unlinked.client, "request-with-hyphen"))
      .rejects.toThrow("POSTGRES_RELATIONAL_READ_LINEAGE_MISMATCH:sample-without-link:sample_item_links:item-with-hyphen");
  });

  it("fails closed when a sample link set omits or invents a declared item", async () => {
    const aggregate = {
      request: { id: "request-with-hyphen" },
      items: [
        { id: "item-with-hyphen", request_id: "request-with-hyphen", requested_at: "2026-09-04T12:00:00.000Z" },
        { id: "item-second", request_id: "request-with-hyphen", requested_at: "2026-09-04T12:00:00.000Z" }
      ],
      samples: [{
        id: "sample-partial-link",
        request_id: "request-with-hyphen",
        accession_code: "ACC-PARTIAL",
        sample_type: "EDTA",
        status: "RECEIVED",
        item_ids: ["item-with-hyphen", "item-second"],
        received_at: "2026-09-04T12:30:00.000Z",
        received_by: "user-with-hyphen",
        version: 1
      }],
      sampleItemLinks: [{
        id: "partial-link",
        sample_id: "sample-partial-link",
        item_id: "item-with-hyphen",
        request_id: "request-with-hyphen",
        link_status: "ACTIVE",
        linked_at: "2026-09-04T12:30:00.000Z",
        linked_by: "user-with-hyphen",
        rejection_note: null,
        version: 1
      }],
      procedures: [], schedules: [], results: [], resultVersions: [], attachments: [], notifications: []
    };
    const partial = client(async (text) => text === RELATIONAL_REQUEST_READ_SQL
      ? { rows: [{ aggregate }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const adapter = new RelationalClinicalCoreAdapter();

    await expect(adapter.readRequest(partial.client, "request-with-hyphen"))
      .rejects.toThrow("POSTGRES_RELATIONAL_READ_LINEAGE_MISMATCH:sample-partial-link:sample_item_links:item-second");

    const unexpected = client(async (text) => text === RELATIONAL_REQUEST_READ_SQL
      ? {
        rows: [{ aggregate: {
          ...aggregate,
          samples: [{ ...aggregate.samples[0], item_ids: ["item-with-hyphen"] }],
          sampleItemLinks: [
            aggregate.sampleItemLinks[0],
            { ...aggregate.sampleItemLinks[0], id: "unexpected-link", item_id: "item-second" }
          ]
        } }], rowCount: 1
      }
      : { rows: [], rowCount: 0 });
    await expect(adapter.readRequest(unexpected.client, "request-with-hyphen"))
      .rejects.toThrow("POSTGRES_RELATIONAL_READ_LINEAGE_MISMATCH:unexpected-link:item_ids");
  });

  it("rejects a cyclic relational replacement chain before it reaches callers", async () => {
    const aggregate = {
      request: { id: "request-with-hyphen" },
      items: [{ id: "item-with-hyphen", request_id: "request-with-hyphen", requested_at: "2026-09-04T12:00:00.000Z" }],
      samples: [
        { id: "sample-a", request_id: "request-with-hyphen", accession_code: "ACC-A", sample_type: "EDTA", status: "RECEIVED", replaces_sample_id: "sample-b", item_ids: ["item-with-hyphen"], received_at: "2026-09-04T12:30:00.000Z", received_by: "user-with-hyphen", version: 1 },
        { id: "sample-b", request_id: "request-with-hyphen", accession_code: "ACC-B", sample_type: "EDTA", status: "RECEIVED", replaces_sample_id: "sample-a", item_ids: ["item-with-hyphen"], received_at: "2026-09-04T12:31:00.000Z", received_by: "user-with-hyphen", version: 1 }
      ],
      sampleItemLinks: [
        { id: "link-a", sample_id: "sample-a", item_id: "item-with-hyphen", request_id: "request-with-hyphen", link_status: "ACTIVE", linked_at: "2026-09-04T12:30:00.000Z", linked_by: "user-with-hyphen", rejection_note: null, version: 1 },
        { id: "link-b", sample_id: "sample-b", item_id: "item-with-hyphen", request_id: "request-with-hyphen", link_status: "ACTIVE", linked_at: "2026-09-04T12:31:00.000Z", linked_by: "user-with-hyphen", rejection_note: null, version: 1 }
      ],
      procedures: [], schedules: [], results: [], resultVersions: [], attachments: [], notifications: []
    };
    const fake = client(async (text) => text === RELATIONAL_REQUEST_READ_SQL
      ? { rows: [{ aggregate }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const adapter = new RelationalClinicalCoreAdapter();

    await expect(adapter.readRequest(fake.client, "request-with-hyphen"))
      .rejects.toThrow("POSTGRES_RELATIONAL_READ_CYCLE:samples:sample-a");
  });

  it("projects new request and item rows with text IDs and version-one inserts", async () => {
    const before = createDemoState("relational-adapter-password");
    const nextRequest = request();
    const nextItem = item();
    nextRequest.itemIds = [nextItem.id];
    const after = {
      ...before,
      requests: [nextRequest],
      items: [nextItem]
    };
    const fake = client();
    const adapter = new RelationalClinicalCoreAdapter();

    await expect(adapter.projectStateDelta(fake.client, before, after)).resolves.toBeUndefined();
    expect(fake.queries).toHaveLength(2);
    expect(fake.queries.map(({ text }) => text)).toEqual([
      expect.stringContaining("INSERT INTO diagnostic_requests"),
      expect.stringContaining("INSERT INTO diagnostic_request_items")
    ]);
    expect(fake.queries[0]?.values[0]).toBe("request-with-hyphen");
    expect(fake.queries[1]?.values[0]).toBe("item-with-hyphen");
    expect(fake.queries.every(({ text }) => !/::uuid/i.test(text))).toBe(true);
  });

  it("replays an identical version-one projection after an insert conflict and rejects drift", async () => {
    const before = createDemoState("relational-idempotent-password");
    const nextRequest = request();
    let replayRows = 1;
    const replay = client(async (text) => {
      if (text.startsWith("INSERT INTO diagnostic_requests")) return { rows: [], rowCount: 0 };
      if (text.startsWith("SELECT id, version FROM diagnostic_requests")) {
        return { rows: replayRows === 1 ? [{ id: nextRequest.id, version: nextRequest.version }] : [], rowCount: replayRows };
      }
      return { rows: [], rowCount: 1 };
    });
    const adapter = new RelationalClinicalCoreAdapter();

    await expect(adapter.projectStateDelta(
      replay.client,
      before,
      { ...before, requests: [nextRequest] }
    )).resolves.toBeUndefined();
    expect(replay.queries[0]?.text).toContain("ON CONFLICT (id) DO NOTHING");
    expect(replay.queries[1]?.text).toMatch(/^SELECT id, version FROM diagnostic_requests WHERE /);
    expect(replay.queries[1]?.text).toContain("request_code IS NOT DISTINCT FROM $2");

    replayRows = 0;
    await expect(adapter.projectStateDelta(
      replay.client,
      before,
      { ...before, requests: [{ ...nextRequest, requestCode: "EX-260904-DRIFT" }] }
    )).rejects.toThrow("POSTGRES_RELATIONAL_INSERT_CONFLICT:diagnostic_requests:request-with-hyphen");
  });

  it("enforces the relational optimistic version predicate before a commit can proceed", async () => {
    const before = createDemoState("relational-version-password");
    const previous = request(1);
    const current = { ...previous, version: 2, aggregateStatus: "IN_PROGRESS" as const };
    const fake = client(async (text) => text.startsWith("UPDATE diagnostic_requests")
      ? { rows: [], rowCount: 0 }
      : { rows: [{ id: "relational-row", version: 1 }], rowCount: 1 });
    const adapter = new RelationalClinicalCoreAdapter();

    await expect(adapter.projectStateDelta(
      fake.client,
      { ...before, requests: [previous] },
      { ...before, requests: [current] }
    )).rejects.toThrow("POSTGRES_RELATIONAL_OPTIMISTIC_VERSION_CONFLICT:diagnostic_requests:request-with-hyphen");
    const update = fake.queries.find(({ text }) => text.startsWith("UPDATE diagnostic_requests"));
    expect(update?.text).toMatch(/WHERE id = \$1 AND version = \$13/);
    expect(update?.values.at(-1)).toBe(1);
  });

  it("does not take ownership of audit or outbox projections", async () => {
    const before = createDemoState("relational-projection-ownership-password");
    const outbox: OutboxMessage = {
      id: "outbox-with-hyphen",
      eventType: "RequestCreated",
      aggregateType: "DiagnosticRequest",
      aggregateId: "request-with-hyphen",
      payload: {},
      consumerType: "DOMAIN_EVENT",
      routingKey: "domain.RequestCreated",
      status: "PENDING",
      attempts: 0,
      availableAt: "2026-09-04T12:00:00.000Z",
      correlationId: "correlation-with-hyphen"
    };
    const after = {
      ...before,
      auditEvents: [{
        id: "audit-with-hyphen",
        eventType: "RequestCreated",
        entityType: "DiagnosticRequest",
        entityId: "request-with-hyphen",
        correlationId: "correlation-with-hyphen",
        metadata: {},
        occurredAt: "2026-09-04T12:00:00.000Z"
      }],
      outbox: [outbox]
    };
    const fake = client();
    const adapter = new RelationalClinicalCoreAdapter();

    await expect(adapter.projectStateDelta(fake.client, before, after)).resolves.toBeUndefined();
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("refuses free-form reasons that the relational aggregate cannot represent losslessly", async () => {
    const before = createDemoState("relational-contract-password");
    const previousItem = item(1);
    const currentItem = { ...previousItem, version: 2, rejectionReason: "free-form clinical explanation" };
    const fake = client();
    const adapter = new RelationalClinicalCoreAdapter();

    await expect(adapter.projectStateDelta(
      fake.client,
      { ...before, items: [previousItem] },
      { ...before, items: [currentItem] }
    )).rejects.toThrow("POSTGRES_RELATIONAL_UNMAPPABLE_STATE:diagnostic_request_items.rejection_reason_id");
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("projects a changed schedule with an optimistic version predicate", async () => {
    const before = createDemoState("relational-schedule-version-password");
    const previous = {
      id: "schedule-with-hyphen",
      procedureId: "procedure-with-hyphen",
      startsAt: "2026-09-04T12:00:00.000Z",
      endsAt: "2026-09-04T12:30:00.000Z",
      resource: "US-01",
      status: "SCHEDULED" as const,
      actorId: "user-with-hyphen",
      createdAt: "2026-09-04T11:00:00.000Z",
      version: 1
    };
    const current = { ...previous, status: "CANCELLED" as const, reason: "Reagendamento", version: 2 };
    const fake = client();
    const adapter = new RelationalClinicalCoreAdapter();

    await expect(adapter.projectStateDelta(
      fake.client,
      { ...before, schedules: [previous] },
      { ...before, schedules: [current] }
    )).resolves.toBeUndefined();

    const update = fake.queries.find(({ text }) => text.startsWith("UPDATE procedure_schedules"));
    expect(update?.text).toMatch(/WHERE id = \$1 AND version = \$12/);
    expect(update?.values.at(-1)).toBe(1);
  });

  it("projects replacement lineage and versioned sample-item links without deleting history", async () => {
    const base = createDemoState("relational-sample-lineage-password");
    const nextRequest = request();
    const nextItem = item();
    nextRequest.itemIds = [nextItem.id];
    const previousSample = {
      id: "sample-initial",
      requestId: nextRequest.id,
      accessionCode: "ACC-0001",
      sampleType: "EDTA",
      status: "RECEIVED" as const,
      itemIds: [nextItem.id],
      receivedAt: "2026-09-04T12:30:00.000Z",
      receivedBy: "user-with-hyphen",
      version: 1
    };
    const replacedSample = {
      ...previousSample,
      status: "REPLACED" as const,
      rejectionCode: "HEMOLYZED",
      rejectionNote: "Amostra hemolisada",
      version: 2
    };
    const replacementSample = {
      id: "sample-replacement",
      requestId: nextRequest.id,
      accessionCode: "PENDING-0001",
      sampleType: "EDTA",
      status: "EXPECTED" as const,
      replacesSampleId: previousSample.id,
      itemIds: [nextItem.id],
      version: 1
    };
    const before = { ...base, requests: [nextRequest], items: [nextItem], samples: [previousSample] };
    const after = { ...base, requests: [nextRequest], items: [nextItem], samples: [replacedSample, replacementSample] };
    const fake = client();
    const adapter = new RelationalClinicalCoreAdapter();

    await expect(adapter.projectStateDelta(fake.client, before, after)).resolves.toBeUndefined();
    expect(fake.queries.map(({ text }) => text)).toEqual([
      expect.stringContaining("UPDATE samples"),
      expect.stringContaining("INSERT INTO samples"),
      expect.stringContaining("UPDATE sample_item_links"),
      expect.stringContaining("INSERT INTO sample_item_links")
    ]);
    const linkUpdate = fake.queries.find(({ text }) => text.startsWith("UPDATE sample_item_links"));
    expect(linkUpdate?.values).toEqual(expect.arrayContaining(["REPLACED", 2, 1]));
    expect(linkUpdate?.values.at(-1)).toBe(1);
    const linkInsert = fake.queries.find(({ text }) => text.startsWith("INSERT INTO sample_item_links"));
    expect(linkInsert?.values).toEqual(expect.arrayContaining(["ACTIVE", 1]));
  });

  it("fails closed before writes for duplicate or cross-request sample links", async () => {
    const base = createDemoState("relational-sample-link-safety-password");
    const nextRequest = request();
    const nextItem = item();
    nextRequest.itemIds = [nextItem.id];
    const duplicateSample = {
      id: "sample-duplicate-link",
      requestId: nextRequest.id,
      accessionCode: "ACC-DUP-LINK",
      sampleType: "EDTA",
      status: "RECEIVED" as const,
      itemIds: [nextItem.id, nextItem.id],
      receivedAt: "2026-09-04T12:30:00.000Z",
      receivedBy: "user-with-hyphen",
      version: 1
    };
    const fakeDuplicate = client();
    const adapter = new RelationalClinicalCoreAdapter();
    await expect(adapter.projectStateDelta(
      fakeDuplicate.client,
      { ...base, requests: [nextRequest], items: [nextItem] },
      { ...base, requests: [nextRequest], items: [nextItem], samples: [duplicateSample] }
    )).rejects.toThrow("POSTGRES_RELATIONAL_DUPLICATE_STATE_ID:sample_item_links:sample-duplicate-link:item-with-hyphen");
    expect(fakeDuplicate.query).not.toHaveBeenCalled();

    const foreignItem = { ...nextItem, id: "foreign-item", requestId: "foreign-request" };
    const foreignSample = { ...duplicateSample, id: "sample-cross-request", accessionCode: "ACC-CROSS-LINK", itemIds: [foreignItem.id] };
    const fakeForeign = client();
    await expect(adapter.projectStateDelta(
      fakeForeign.client,
      { ...base, requests: [nextRequest], items: [foreignItem] },
      { ...base, requests: [nextRequest], items: [foreignItem], samples: [foreignSample] }
    )).rejects.toThrow("POSTGRES_RELATIONAL_UNMAPPABLE_STATE:sample_item_links:sample-cross-request");
    expect(fakeForeign.query).not.toHaveBeenCalled();

    const cycleA = { ...duplicateSample, id: "sample-cycle-a", accessionCode: "ACC-CYCLE-A", itemIds: [nextItem.id], replacesSampleId: "sample-cycle-b" };
    const cycleB = { ...duplicateSample, id: "sample-cycle-b", accessionCode: "ACC-CYCLE-B", itemIds: [nextItem.id], replacesSampleId: cycleA.id };
    const fakeCycle = client();
    await expect(adapter.projectStateDelta(
      fakeCycle.client,
      { ...base, requests: [nextRequest], items: [nextItem] },
      { ...base, requests: [nextRequest], items: [nextItem], samples: [cycleA, cycleB] }
    )).rejects.toThrow("POSTGRES_RELATIONAL_CYCLE:samples:sample-cycle-a");
    expect(fakeCycle.query).not.toHaveBeenCalled();
  });
});
