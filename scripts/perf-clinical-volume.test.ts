import assert from "node:assert/strict";
import test from "node:test";
import { createDemoState } from "../src/server/store/fixtures";
import { addClinicalVolume, D2_EXAMS_PER_DAY } from "./perf-clinical-volume";

const NOW = new Date("2026-10-09T12:00:00.000Z");

test("12 months at the D2 rate is about 55 thousand exams, with only the last two days open", () => {
  const state = createDemoState("clinical-volume-password");
  const before = { patients: state.patients.length, requests: state.requests.length };
  const summary = addClinicalVolume(state, { months: 12, now: NOW });
  assert.deepEqual(summary, { months: 12, examsPerDay: D2_EXAMS_PER_DAY, days: 365, patients: 6_844, requests: 27_375, items: 54_750, activeRequests: 150, auditEvents: 27_375 + 3 * (27_375 - 150) });
  assert.equal(state.auditEvents.length, summary.auditEvents);
  assert.deepEqual(new Set(state.auditEvents.map((event) => event.actorId)), new Set(["user-vet", "user-lab", "user-rx"]));
  assert.equal(state.requests.length - before.requests, 27_375);
  assert.equal(state.items.length, 54_750);
  assert.equal(state.patients.length - before.patients, 6_844);
  const open = state.requests.filter((request) => request.aggregateStatus === "REQUESTED");
  assert.equal(open.length, 150);
  assert.ok(open.every((request) => Date.parse(request.createdAt) >= NOW.getTime() - 2 * 86_400_000 && Date.parse(request.createdAt) < NOW.getTime()));
  // Completed exams carry their results; open ones carry nothing yet.
  assert.equal(state.results.length, 27_375 - 150);
  assert.equal(state.resultVersions.length, 2 * (27_375 - 150));
  assert.ok(state.items.filter((item) => item.status === "REQUESTED").every((item) => !item.currentResultId && !item.procedureId));
});

test("every reference resolves and every identifier and code is unique", () => {
  const state = createDemoState("clinical-volume-password");
  addClinicalVolume(state, { months: 2, examsPerDay: 40, now: NOW });
  const ids = (entries: Array<{ id: string }>) => new Set(entries.map((entry) => entry.id));
  for (const collection of [state.patients, state.encounters, state.requests, state.items, state.samples, state.procedures, state.schedules, state.results, state.resultVersions, state.notifications, state.auditEvents]) {
    assert.equal(ids(collection).size, collection.length);
  }
  assert.equal(new Set(state.requests.map((request) => request.requestCode)).size, state.requests.length);
  assert.equal(new Set(state.samples.map((sample) => sample.accessionCode)).size, state.samples.length);
  const patients = ids(state.patients);
  const encounters = new Map(state.encounters.map((encounter) => [encounter.id, encounter]));
  const requests = ids(state.requests);
  const items = ids(state.items);
  const services = new Set(state.services.map((service) => service.id));
  for (const request of state.requests) {
    assert.ok(patients.has(request.patientId));
    assert.equal(encounters.get(request.encounterId)?.patientId, request.patientId);
    assert.ok(request.itemIds.every((itemId) => items.has(itemId)));
  }
  for (const item of state.items) assert.ok(requests.has(item.requestId) && services.has(item.serviceId));
  for (const sample of state.samples) assert.ok(requests.has(sample.requestId) && sample.itemIds.every((itemId) => items.has(itemId)));
  for (const result of state.results) assert.ok(items.has(result.itemId) && state.resultVersions.some((version) => version.id === result.currentVersionId));
  for (const procedure of state.procedures) assert.ok(items.has(procedure.itemId));
  for (const event of state.auditEvents) assert.ok(event.entityType === "DiagnosticRequest" ? requests.has(event.entityId) : items.has(event.entityId));
});

test("the same options give the same history, and hostile options are refused", () => {
  const first = createDemoState("clinical-volume-password");
  const second = createDemoState("clinical-volume-password");
  addClinicalVolume(first, { months: 1, now: NOW, activeDays: 0 });
  addClinicalVolume(second, { months: 1, now: NOW, activeDays: 0 });
  assert.deepEqual(first.requests, second.requests);
  assert.ok(first.requests.every((request) => request.aggregateStatus === "COMPLETED"));
  for (const options of [{ months: 0 }, { months: 37 }, { months: 1.5 }, { months: 1, examsPerDay: 1 }, { months: 1, examsPerDay: 2_001 }, { months: 1, activeDays: -1 }, { months: 1, activeDays: 31 }]) {
    assert.throws(() => addClinicalVolume(createDemoState("clinical-volume-password"), options), /CLINICAL_VOLUME_INVALID/);
  }
});
