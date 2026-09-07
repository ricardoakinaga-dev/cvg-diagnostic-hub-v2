import { describe, expect, it, vi } from "vitest";
import { createDemoState } from "../fixtures";
import type { RelationalSqlClient } from "./clinical-core-contracts";
import {
  RELATIONAL_REQUEST_READ_SQL,
  RelationalClinicalCoreAdapter
} from "./clinical-core-adapter";

type RawRow = Record<string, unknown>;

type RawAggregate = {
  request: RawRow;
  items: RawRow[];
  samples: RawRow[];
  sampleItemLinks: RawRow[];
  procedures: RawRow[];
  schedules: RawRow[];
  results: RawRow[];
  resultVersions: RawRow[];
  attachments: RawRow[];
  notifications: RawRow[];
};

const REQUEST_ID = "request-read-coverage";
const ITEM_ID = "item-read-coverage";
const SAMPLE_ID = "sample-read-coverage";
const TIMESTAMP = "2026-09-07T12:00:00.000Z";

function validAggregate(): RawAggregate {
  const state = createDemoState("clinical-core-read-coverage-password");
  const patient = state.patients[0];
  const encounter = state.encounters[0];
  const requester = state.users.find((user) => user.id === "user-vet");
  const laboratoryUser = state.users.find((user) => user.id === "user-lab");
  const service = state.services.find((candidate) => candidate.id === "service-hemogram");

  if (!patient || !encounter || !requester || !laboratoryUser || !service) {
    throw new Error("clinical-core-read-coverage fixture is incomplete");
  }

  return {
    request: {
      id: REQUEST_ID,
      request_code: "READ-COVERAGE-001",
      patient_id: patient.id,
      encounter_id: encounter.id,
      requester_id: requester.id,
      requesting_department_id: requester.departmentCode,
      priority: "ROUTINE",
      aggregate_status: "REQUESTED",
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP,
      version: 1
    },
    items: [{
      id: ITEM_ID,
      request_id: REQUEST_ID,
      service_id: service.id,
      department_id: service.departmentCode,
      workflow_type: service.workflowType,
      priority: "ROUTINE",
      status: "REQUESTED",
      requested_at: TIMESTAMP,
      version: 1
    }],
    samples: [{
      id: SAMPLE_ID,
      request_id: REQUEST_ID,
      accession_code: "ACC-READ-001",
      sample_type: "EDTA",
      status: "RECEIVED",
      item_ids: [ITEM_ID],
      collected_at: TIMESTAMP,
      received_at: TIMESTAMP,
      received_by: laboratoryUser.id,
      version: 1
    }],
    sampleItemLinks: [{
      id: `sample-item-link:${SAMPLE_ID}:${ITEM_ID}`,
      sample_id: SAMPLE_ID,
      item_id: ITEM_ID,
      request_id: REQUEST_ID,
      link_status: "ACTIVE",
      linked_at: TIMESTAMP,
      linked_by: laboratoryUser.id,
      rejection_note: null,
      version: 1
    }],
    procedures: [{ id: "procedure-read-coverage", item_id: ITEM_ID }],
    schedules: [{ id: "schedule-read-coverage", procedure_id: "procedure-read-coverage" }],
    results: [{ id: "result-read-coverage", item_id: ITEM_ID }],
    resultVersions: [{ id: "result-version-read-coverage", result_id: "result-read-coverage" }],
    attachments: [{ id: "attachment-read-coverage", result_version_id: "result-version-read-coverage" }],
    notifications: [{ id: "notification-read-coverage", entity_id: REQUEST_ID }]
  };
}

function mockedReaderResult(
  row: unknown,
  rowCount = 1
): { client: RelationalSqlClient; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (_text: string, _values?: unknown[]) => ({
    rows: rowCount === 0 ? [] : [row],
    rowCount
  }));
  return { client: { query }, query };
}

describe("relational clinical-core reader behavior", () => {
  it.each([
    ["missing envelope", {}, "POSTGRES_RELATIONAL_READ_INVALID"],
    ["non-object envelope", { aggregate: null }, "POSTGRES_RELATIONAL_READ_INVALID"],
    [
      "malformed collection",
      { aggregate: { ...validAggregate(), items: {} } },
      "POSTGRES_RELATIONAL_READ_INVALID:items"
    ]
  ])("fails closed for an absent or malformed envelope (%s)", async (_caseName, row, errorCode) => {
    const { client } = mockedReaderResult(row);

    await expect(new RelationalClinicalCoreAdapter().readRequest(client, REQUEST_ID))
      .rejects.toThrow(errorCode);
  });

  it("rejects a row that crosses the requested aggregate scope", async () => {
    const aggregate = validAggregate();
    aggregate.items[0] = { ...aggregate.items[0], request_id: "request-from-another-scope" };
    const { client } = mockedReaderResult({ aggregate });

    await expect(new RelationalClinicalCoreAdapter().readRequest(client, REQUEST_ID))
      .rejects.toThrow(`POSTGRES_RELATIONAL_READ_SCOPE_MISMATCH:items:${ITEM_ID}`);
  });

  it("rejects duplicated entity IDs instead of selecting an arbitrary row", async () => {
    const aggregate = validAggregate();
    aggregate.items.push({ ...aggregate.items[0] });
    const { client } = mockedReaderResult({ aggregate });

    await expect(new RelationalClinicalCoreAdapter().readRequest(client, REQUEST_ID))
      .rejects.toThrow(`POSTGRES_RELATIONAL_READ_DUPLICATE:items:${ITEM_ID}`);
  });

  it.each([0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid sample version (%s)",
    async (version) => {
      const aggregate = validAggregate();
      aggregate.samples[0] = { ...aggregate.samples[0], version };
      const { client } = mockedReaderResult({ aggregate });

      await expect(new RelationalClinicalCoreAdapter().readRequest(client, REQUEST_ID))
        .rejects.toThrow(`POSTGRES_RELATIONAL_READ_LINEAGE_MISMATCH:relational_samples.version:${SAMPLE_ID}`);
    }
  );

  it("returns a request with explicitly empty child aggregates", async () => {
    const aggregate = validAggregate();
    aggregate.items = [];
    aggregate.samples = [];
    aggregate.sampleItemLinks = [];
    aggregate.procedures = [];
    aggregate.schedules = [];
    aggregate.results = [];
    aggregate.resultVersions = [];
    aggregate.attachments = [];
    aggregate.notifications = [];
    const { client } = mockedReaderResult({ aggregate });

    await expect(new RelationalClinicalCoreAdapter().readRequest(client, REQUEST_ID))
      .resolves.toEqual(aggregate);
  });

  it("reads a valid aggregate through the public relational contract", async () => {
    const aggregate = validAggregate();
    const { client, query } = mockedReaderResult({ aggregate });

    await expect(new RelationalClinicalCoreAdapter().readRequest(client, REQUEST_ID))
      .resolves.toEqual(aggregate);
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(RELATIONAL_REQUEST_READ_SQL, [REQUEST_ID]);
  });
});
