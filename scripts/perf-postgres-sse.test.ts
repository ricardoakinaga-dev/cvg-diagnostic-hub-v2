import assert from "node:assert/strict";
import test from "node:test";
import { isHealthySse, observeSse } from "./perf-postgres-sse";

const encoder = new TextEncoder();
test("requires complete valid frames and tracks clinical mutation delivery", async () => {
  const abort = new AbortController();
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
  const observation = observeSse(body, abort.signal);
  stream!.enqueue(encoder.encode("retry: 5000\n\n: heart"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observation.frames, 0);
  stream!.enqueue(encoder.encode("beat\n\nevent: diagnostic.updated\ndata: {\"entityId\":\"request-test\"}\n\n"));
  await observation.ready;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observation.heartbeats, 1);
  assert.equal(observation.frames, 2);
  assert.ok(observation.entityIds.has("request-test"));
  abort.abort();
  await observation.finished;
  assert.equal(observation.unexpectedClosure, false);
});

test("unterminated garbage cannot admit a stalled stream", async () => {
  const abort = new AbortController();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode("garbage")); } });
  const observation = observeSse(body, abort.signal);
  let admitted = false;
  const pending = observation.ready.then(() => { admitted = true; }, () => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(admitted, false);
  assert.equal(observation.frames, 0);
  abort.abort();
  await pending;
  await observation.finished;
});

test("invalid frames and payloads are recorded as protocol failures", async () => {
  for (const frame of ["garbage\n\n", "event: diagnostic.updated\ndata: invalid\n\n"]) {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(frame)); controller.close(); } });
    const observation = observeSse(body, new AbortController().signal);
    await assert.rejects(observation.ready);
    await observation.finished;
    assert.equal(observation.unexpectedClosure, true);
    assert.ok(observation.protocolError);
  }
});

test("an unexpected EOF after admission is detected", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(": heartbeat\n\n")); controller.close(); } });
  const observation = observeSse(body, new AbortController().signal);
  await observation.ready;
  await observation.finished;
  assert.equal(observation.unexpectedClosure, true);
});

test("delivery followed by a stalled stream does not establish health after the load", async () => {
  const abort = new AbortController();
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    source = controller;
    controller.enqueue(encoder.encode('event: diagnostic.updated\ndata: {"entityId":"request-test"}\n\n'));
  } });
  const observation = observeSse(body, abort.signal);
  await observation.ready;
  const measurementFinishedAt = performance.now() + 1;
  assert.equal(isHealthySse(observation, ["request-test"], 1, measurementFinishedAt), false);
  await new Promise((resolve) => setTimeout(resolve, 5));
  source!.enqueue(encoder.encode(": heartbeat\n\n"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(isHealthySse(observation, ["request-test"], 1, measurementFinishedAt), true);
  assert.equal(isHealthySse(observation, ["missing"], 1, measurementFinishedAt), false);
  assert.equal(isHealthySse(observation, [], 1, measurementFinishedAt), false);
  abort.abort();
  await observation.finished;
});
