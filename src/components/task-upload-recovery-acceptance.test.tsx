/** @vitest-environment jsdom */
import { createHash, webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionUser } from "@cvg/contracts";
import { HospitalTaskAttachments } from "./hospital-task-attachments";
import { apiFetch, ApiClientError } from "./api-client";
import { ApiError } from "../server/http/envelope";
import { createDemoState } from "../server/store/fixtures";
import { MemoryStore } from "../server/store/memory-store";
import { createApplicationService } from "../server/application/service";
import { createHospitalTaskAttachmentService } from "../server/application/hospital-task-attachment-service";
import type { FileStore } from "../server/storage/file-store";

vi.mock("./api-client", async original => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it.each(["content", "finalize"] as const)("shows a recoverable %s failure and resumes the native attachment without duplicating its session or finalized reference", async stage => {
  const base = createDemoState("synthetic-visible-task-upload-recovery");
  const store = new MemoryStore(base); const actor = base.users.find(user => user.id === "user-vet")!;
  const files = new Map<string, Buffer>(); let failure = true;
  const storage: FileStore = {
    put: async (key, content) => { if (stage === "content" && failure) { failure = false; throw new Error("synthetic storage outage"); } files.set(key, Buffer.from(content)); },
    get: async key => { const content = files.get(key); if (!content) throw new Error("synthetic missing file"); return content; },
    remove: async key => { files.delete(key); }, exists: async key => files.has(key)
  };
  const service = { ...createApplicationService(store, { storage }), ...createHospitalTaskAttachmentService({ store, storage, scanner: { scan: async () => "CLEAN" }, patientDiagnosticsAuxiliaryReader: () => ({ samples: [], results: [], attachments: [] }) }) };
  const view = await service.createHospitalTask(actor, { title: "Retomada visível exclusivamente sintética", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", responsibleUserId: actor.id, priority: "ROUTINE", idempotencyKey: "visible-upload-task" });
  const user: SessionUser = { id: actor.id, email: actor.email, displayName: actor.displayName, role: actor.role, departmentCode: actor.departmentCode, timezone: actor.timezone, permissions: view.permissions };
  const bytes = Buffer.from("%PDF-1.7\nOnly synthetic visible-recovery evidence\n");
  vi.stubGlobal("crypto", webcrypto);
  // Only transport is bridged; validation, versions, quarantine, claims and
  // persisted attachment references are the actual application commands.
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const key = new Headers(init?.headers).get("idempotency-key") ?? "";
    try {
      if (path.startsWith(`/hospital-tasks/${view.task.id}/attachments?`)) return await service.listHospitalTaskAttachments(actor, view.task.id) as never;
      if (path.endsWith("/upload-sessions")) return await service.createHospitalTaskAttachmentSession(actor, view.task.id, { ...JSON.parse(String(init?.body)), idempotencyKey: key }) as never;
      const attachmentId = path.split("/")[2];
      if (path.endsWith("/content")) return await service.uploadHospitalTaskAttachment(actor, attachmentId, new Uint8Array(init?.body as ArrayBuffer)) as never;
      if (path.endsWith("/finalize")) {
        if (stage === "finalize" && failure) { failure = false; throw new ApiError("STORAGE_UNAVAILABLE", "Synthetic finalization transport outage", 503); }
        return await service.finalizeHospitalTaskAttachment(actor, attachmentId, { ...JSON.parse(String(init?.body)), idempotencyKey: key }) as never;
      }
      throw new Error(`Unexpected synthetic upload route ${path}`);
    } catch (error) {
      if (error instanceof ApiError) throw new ApiClientError(error.status, { error: { code: error.code } });
      throw error;
    }
  });
  render(<HospitalTaskAttachments user={user} view={view} />);
  const file = new File([new Uint8Array(bytes)], "recovery.pdf", { type: "application/pdf" });
  fireEvent.change(screen.getByLabelText(/Anexar PDF/), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Enviar ou retomar anexo" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Enviar ou retomar anexo" })).toBeEnabled();
  expect(screen.getByLabelText(/Anexar PDF/)).toHaveProperty("files", [file]);
  expect(screen.queryByRole("link", { name: /Baixar/ })).not.toBeInTheDocument();
  const pending = store.getState().hospitalTaskAttachments;
  expect(pending).toHaveLength(1); const attachmentId = pending[0].id;
  expect(pending[0]).toMatchObject({ scanStatus: stage === "content" ? "PENDING" : "CLEAN", uploadStatus: stage === "content" ? "INITIATED" : "UPLOADED" });
  await expect(service.downloadHospitalTaskAttachment(actor, attachmentId)).rejects.toMatchObject({ status: 404 });
  fireEvent.click(screen.getByRole("button", { name: "Enviar ou retomar anexo" }));
  await screen.findByText("Arquivo finalizado e verificado.");
  await screen.findByRole("link", { name: "Baixar recovery.pdf" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Enviar ou retomar anexo" })).toBeDisabled());
  const persisted = store.getState().hospitalTaskAttachments;
  expect(persisted).toHaveLength(1);
  expect(persisted[0]).toMatchObject({ id: attachmentId, uploadStatus: "FINALIZED", scanStatus: "CLEAN", version: 3, checksum: createHash("sha256").update(bytes).digest("hex") });
  expect((await service.downloadHospitalTaskAttachment(actor, attachmentId)).content).toEqual(bytes);
  const calls = vi.mocked(apiFetch).mock.calls;
  expect(calls.filter(([path]) => path.endsWith("/upload-sessions"))).toHaveLength(1);
  const contentCalls = calls.filter(([path]) => path.endsWith("/content"));
  expect(contentCalls).toHaveLength(stage === "content" ? 2 : 1);
  expect(new Set(contentCalls.map(([path]) => path))).toEqual(new Set([`/hospital-task-attachments/${attachmentId}/content`]));
  expect(new Set(contentCalls.map(([, init]) => new Headers(init?.headers).get("idempotency-key"))).size).toBe(1);
  const finalizeCalls = calls.filter(([path]) => path.endsWith("/finalize"));
  expect(finalizeCalls).toHaveLength(stage === "finalize" ? 2 : 1);
  expect(new Set(finalizeCalls.map(([, init]) => new Headers(init?.headers).get("idempotency-key"))).size).toBe(1);
  expect(store.getState().auditEvents.filter(event => event.eventType === "HospitalTaskAttachmentFinalized")).toHaveLength(1);
  expect(store.getState().results).toEqual(base.results); expect(store.getState().patientGrants).toEqual(base.patientGrants);
});
