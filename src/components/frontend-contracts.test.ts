import { describe, expect, it } from "vitest";
import type { QueueItem, SessionResponse } from "@cvg/contracts";

const sessionResponse = {
  user: {
    id: "user-1",
    email: "vet@cvg.local",
    displayName: "Dra. Marina Costa",
    role: "VETERINARIAN",
    departmentCode: "LABORATORY",
    timezone: "America/Sao_Paulo"
  }
} satisfies SessionResponse;

const queueItem = {
  id: "item-1",
  requestId: "request-1",
  status: "REQUESTED",
  workflowType: "LABORATORY",
  priority: "URGENT",
  version: 1,
  dueAt: "2026-08-25T12:00:00.000Z",
  createdAt: "2026-08-25T08:00:00.000Z",
  requestCode: "EX-0001",
  nextAction: "Receber amostra",
  overdue: false,
  patient: { id: "patient-1", displayName: "Thor", species: "Canino", externalId: "HIS-THOR" },
  service: { id: "service-1", code: "HEMOGRAM", name: "Hemograma" },
  operationalContext: {
    currentOwner: { code: "REQUESTING_TEAM", label: "Equipe solicitante" },
    nextAction: { code: "COLLECT_SAMPLE", label: "Receber amostra" },
    blockedBy: null,
    waitingSince: null,
    expectedBy: "2026-08-25T12:00:00.000Z",
    escalationLevel: "NONE"
  }
} satisfies QueueItem;

describe("frontend API contracts", () => {
  it("keeps session and queue fixtures checked by @cvg/contracts", () => {
    expect(sessionResponse.user.role).toBe("VETERINARIAN");
    expect(queueItem.service.code).toBe("HEMOGRAM");
    expect(queueItem.operationalContext.nextAction.code).toBe("COLLECT_SAMPLE");
  });
});
