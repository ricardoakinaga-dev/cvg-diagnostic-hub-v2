import { hospitalTaskContextSchema, hospitalTaskTypeCreateSchema, hospitalTaskTypePatchSchema, hospitalTaskCreateSchema, hospitalTaskPatchSchema, hospitalTaskAssignmentSchema, hospitalTaskPrioritySchema, hospitalTaskCommandSchema, hospitalTaskDependencySchema, hospitalTaskFiltersSchema, hospitalIntakeOptionsSchema, hospitalIntakeFiltersSchema, hospitalIntakeCreateSchema, hospitalIntakeTriageSchema, plannerSearchFiltersSchema } from "../../../../server/http/hospital-task-schemas";
import { responseFor, objectBody, parseCommandBody, parseVersionedCommandBody, commandMeta, parseBooleanFilter, parseLimit, parseCursor } from "./route-support";
import type { ApiHandlerGroup } from "./route-support";

function queryBody(request: Request) {
  const query = new URL(request.url).searchParams;
  return { ...Object.fromEntries(query), ...Object.fromEntries(["assignedToMe", "includeArchived", "includeDrafts"].filter((key) => query.has(key)).map((key) => [key, parseBooleanFilter(query.get(key), key)])), ...(query.has("limit") ? { limit: Number(query.get("limit")) } : {}), ...(query.has("types") ? { types: query.get("types")!.split(",") } : {}) };
}
export const hospitalTaskHandlers = {
  listHospitalTaskTypes: { authentication: "session", handle: async ({ actor, service, correlationId, id }) => responseFor(await service.listHospitalTaskTypes(actor), correlationId, id) },
  createHospitalTaskType: { authentication: "session", handle: async ({ request, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request); const input = parseCommandBody(body, hospitalTaskTypeCreateSchema, "Tipo de tarefa inválido.");
    return responseFor(await service.createHospitalTaskType(actor, { ...input, ...commandMeta(request, body, operation) }), correlationId, id, 201);
  } },
  updateHospitalTaskType: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request); const input = parseVersionedCommandBody(request, body, operation, hospitalTaskTypePatchSchema, "Alteração do tipo inválida.");
    return responseFor(await service.updateHospitalTaskType(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  listHospitalTaskOptions: { authentication: "session", handle: async ({ actor, service, correlationId, id }) => responseFor(await service.listHospitalTaskOptions(actor), correlationId, id) },
  listHospitalTasks: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => {
    const input = parseCommandBody(queryBody(request), hospitalTaskFiltersSchema, "Filtros de tarefas inválidos.");
    return responseFor(await service.listHospitalTasks(actor, input), correlationId, id);
  } },
  getHospitalTask: { authentication: "session", handle: async ({ path, actor, service, correlationId, id }) => responseFor(await service.getHospitalTask(actor, path[1]), correlationId, id) },
  getHospitalTaskHistory: { authentication: "session", handle: async ({ request, path, actor, service, correlationId, id }) => {
    const query = new URL(request.url).searchParams;
    const page = await service.getHospitalTaskHistory(actor, path[1], { limit: parseLimit(query.get("limit")), cursor: parseCursor(query.get("cursor")) });
    return responseFor(page.items, correlationId, id, 200, { nextCursor: page.nextCursor, limit: page.limit, total: page.total });
  } },
  createHospitalTask: { authentication: "session", handle: async ({ request, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request); const input = parseCommandBody(body, hospitalTaskCreateSchema, "Tarefa hospitalar inválida.");
    return responseFor(await service.createHospitalTask(actor, { ...input, ...commandMeta(request, body, operation) }), correlationId, id, 201);
  } },
  updateHospitalTask: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request); const input = parseVersionedCommandBody(request, body, operation, hospitalTaskPatchSchema, "Alteração da tarefa inválida.");
    return responseFor(await service.updateHospitalTask(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  updateHospitalTaskContext: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request); const input = parseVersionedCommandBody(request, body, operation, hospitalTaskContextSchema, "Contexto assistencial inválido.");
    return responseFor(await service.updateHospitalTaskContext(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  assignHospitalTask: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request); const input = parseVersionedCommandBody(request, body, operation, hospitalTaskAssignmentSchema, "Responsabilidade da tarefa inválida.");
    return responseFor(await service.assignHospitalTask(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  reprioritizeHospitalTask: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request); const input = parseVersionedCommandBody(request, body, operation, hospitalTaskPrioritySchema, "Prioridade da tarefa inválida.");
    return responseFor(await service.reprioritizeHospitalTask(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  commandHospitalTask: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request); const input = parseVersionedCommandBody(request, body, operation, hospitalTaskCommandSchema, "Comando da tarefa inválido.");
    return responseFor(await service.commandHospitalTask(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  putHospitalTaskDependency: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request); const input = parseVersionedCommandBody(request, body, operation, hospitalTaskDependencySchema, "Dependência da tarefa inválida.");
    return responseFor(await service.putHospitalTaskDependency(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  getHospitalIntakeOptions: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => {
    const input = parseCommandBody(queryBody(request), hospitalIntakeOptionsSchema, "Setor de triagem inválido.");
    return responseFor(await service.getHospitalIntakeOptions(actor, input), correlationId, id);
  } },
  listHospitalIntakes: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => {
    const input = parseCommandBody(queryBody(request), hospitalIntakeFiltersSchema, "Filtros de demandas inválidos.");
    return responseFor(await service.listHospitalIntakes(actor, input), correlationId, id);
  } },
  createHospitalIntake: { authentication: "session", handle: async ({ request, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request); const input = parseCommandBody(body, hospitalIntakeCreateSchema, "Demanda hospitalar inválida.");
    return responseFor(await service.createHospitalIntake(actor, { ...input, ...commandMeta(request, body, operation) }), correlationId, id, 201);
  } },
  triageHospitalIntake: { authentication: "session", handle: async ({ request, path, operation, actor, service, correlationId, id }) => {
    const body = await objectBody(request); const input = parseVersionedCommandBody(request, body, operation, hospitalIntakeTriageSchema, "Decisão de triagem inválida.");
    return responseFor(await service.triageHospitalIntake(actor, path[1], { ...input, ...commandMeta(request, body, operation) }), correlationId, id);
  } },
  searchPlanner: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => {
    const input = parseCommandBody(queryBody(request), plannerSearchFiltersSchema, "Filtros de busca inválidos.");
    return responseFor(await service.searchPlanner(actor, input.query ?? "", input), correlationId, id);
  } }
} satisfies ApiHandlerGroup;
