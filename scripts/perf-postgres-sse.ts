export interface SseObservation {
  frames: number;
  heartbeats: number;
  lastFrameAtMs: number;
  entityIds: Set<string>;
  unexpectedClosure: boolean;
  protocolError?: string;
  ready: Promise<void>;
  finished: Promise<void>;
}

export function isHealthySse(observation: SseObservation, writeIds: readonly string[], expectedWrites: number, measurementFinishedAt: number): boolean {
  return !observation.unexpectedClosure && !observation.protocolError && writeIds.length === expectedWrites && expectedWrites > 0
    && writeIds.every((id) => observation.entityIds.has(id)) && observation.lastFrameAtMs >= measurementFinishedAt;
}

/** Observe complete SSE frames, not just headers or arbitrary bytes. */
export function observeSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): SseObservation {
  let ready = false;
  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const observation: SseObservation = {
    frames: 0, heartbeats: 0, lastFrameAtMs: 0, entityIds: new Set(), unexpectedClosure: false,
    ready: readyPromise, finished: Promise.resolve()
  };
  const reader = body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  observation.finished = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replaceAll("\r\n", "\n");
        if (buffer.length > 512 * 1024) throw new Error("SSE frame exceeded the bounded observation buffer.");
        let end = buffer.indexOf("\n\n");
        while (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const lines = frame.split("\n");
          if (lines.some((line) => line && !/^(:|retry:|id:|event:|data:)/.test(line))) throw new Error("Malformed SSE frame.");
          const heartbeat = lines.some((line) => line.startsWith(": heartbeat"));
          const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          if (heartbeat) observation.heartbeats++;
          if (event) {
            const payload: unknown = JSON.parse(lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n"));
            if (!payload || typeof payload !== "object") throw new Error("Invalid SSE event payload.");
            if (event === "diagnostic.updated" && "entityId" in payload && typeof payload.entityId === "string") observation.entityIds.add(payload.entityId);
          }
          if (heartbeat || event) {
            observation.frames++;
            observation.lastFrameAtMs = performance.now();
            if (!ready) { ready = true; resolveReady(); }
          }
          end = buffer.indexOf("\n\n");
        }
      }
      if (!signal.aborted) observation.unexpectedClosure = true;
    } catch (error) {
      if (!signal.aborted) {
        observation.unexpectedClosure = true;
        observation.protocolError = error instanceof Error ? error.message : "SSE observation failed.";
      }
    } finally {
      if (!ready) rejectReady(new Error(observation.protocolError ?? "SSE ended before a complete heartbeat/event frame."));
      signal.removeEventListener("abort", onAbort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  })();
  return observation;
}
