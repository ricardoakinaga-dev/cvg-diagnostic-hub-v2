import type { ApiOperation } from "./api-operation-manifest";

export type ApiHandlerEntry<PublicContext, SessionContext> =
  | Readonly<{ authentication: "public"; handle: (context: PublicContext) => Response | Promise<Response> }>
  | Readonly<{ authentication: "session"; handle: (context: SessionContext) => Response | Promise<Response> }>;

/** Freeze a complete registry; missing, duplicate or misclassified handlers fail startup. */
export function createApiHandlerRegistry<PublicContext, SessionContext>(
  operations: ReadonlyArray<Pick<ApiOperation, "operationId" | "authentication">>,
  groups: ReadonlyArray<Readonly<Record<string, ApiHandlerEntry<PublicContext, SessionContext>>>>
) {
  const handlers = new Map<string, ApiHandlerEntry<PublicContext, SessionContext>>();
  for (const group of groups) {
    for (const [id, entry] of Object.entries(group)) {
      if (handlers.has(id)) throw new Error(`API_HANDLER_DUPLICATE:${id}`);
      if (!entry || typeof entry.handle !== "function") throw new Error(`API_HANDLER_INVALID:${id}`);
      handlers.set(id, Object.freeze({ ...entry }));
    }
  }
  const expected = new Set<string>();
  for (const operation of operations) {
    const id = operation.operationId;
    if (expected.has(id)) throw new Error(`API_OPERATION_DUPLICATE:${id}`);
    expected.add(id);
    const entry = handlers.get(id);
    if (!entry) throw new Error(`API_HANDLER_MISSING:${id}`);
    if (entry.authentication !== operation.authentication) throw new Error(`API_HANDLER_AUTHENTICATION:${id}`);
  }
  for (const id of handlers.keys()) {
    if (!expected.has(id)) throw new Error(`API_HANDLER_UNKNOWN:${id}`);
  }
  return Object.freeze({
    operationIds: Object.freeze([...handlers.keys()]),
    resolve(id: string): ApiHandlerEntry<PublicContext, SessionContext> {
      const handler = handlers.get(id);
      if (!handler) throw new Error(`API_HANDLER_MISSING:${id}`);
      return handler;
    }
  });
}
