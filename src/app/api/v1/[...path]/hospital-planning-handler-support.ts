import type { z } from "zod";
import type { CommandMeta } from "../../../../server/application/service-types";
import { commandMeta, objectBody, parseBooleanFilter, parseCommandBody, parseLimit, parseVersionedCommandBody, responseFor, type SessionHandlerContext } from "./route-support";

export function planningFilters<T>(request: Request, schema: z.ZodType<T>, booleanKeys: string[] = []): T {
  const query = new URL(request.url).searchParams;
  const input: Record<string, unknown> = Object.fromEntries(query);
  if (query.has("limit")) input.limit = parseLimit(query.get("limit"));
  for (const key of booleanKeys) if (query.has(key)) input[key] = parseBooleanFilter(query.get(key), key);
  return parseCommandBody(input, schema, "Filtros de planejamento inválidos.");
}
export async function planningCommand<T extends Record<string, unknown>>(context: SessionHandlerContext, schema: z.ZodType<T>, invoke: (input: T & CommandMeta) => Promise<unknown>, versioned = true, status: 200 | 201 = 200) {
  const { request, operation, correlationId, id } = context;
  const body = await objectBody(request);
  const input = versioned ? parseVersionedCommandBody(request, body, operation, schema, "Comando de planejamento inválido.") : parseCommandBody(body, schema, "Comando de planejamento inválido.");
  return responseFor(await invoke({ ...input, ...commandMeta(request, body, operation) }), correlationId, id, status);
}
