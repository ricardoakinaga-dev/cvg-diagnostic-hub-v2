/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HospitalAiSuggestion, HospitalDocumentView, HospitalIntegrationCredentialView, HospitalIntegrationReceipt, Permission, SessionUser } from "@cvg/contracts";
import { HospitalDocumentAssistance } from "./hospital-document-assistance";
import { HospitalIntegrationConsole } from "./hospital-integration-console";
import { HospitalHisV4Discovery } from "./hospital-his-v4-discovery";
import { apiFetch, apiFetchWithMeta, ApiClientError } from "./api-client";
import { hospitalUser, uiPage } from "./hospital-ui.test-helpers";
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn(), apiFetchWithMeta: vi.fn() }));
const text = { type: "hospital-document", version: 1, blocks: [{ type: "paragraph", content: [{ text: "Texto operacional revisável" }] }] } as const;
const permissions: Permission[] = ["hospital_document.view", "hospital_document.update", "integration.manage", "integration.exchange", "hospital_intake.view"];
const user: SessionUser = { ...hospitalUser, permissions };
function documentView(): HospitalDocumentView { return { permissions, favorite: false, document: { id: "document", code: "DOC", title: "Rotina", departmentCode: "INPATIENT", responsibleUserId: user.id, locked: false, archived: false, version: 4, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z", createdBy: user.id, draftRevisionId: "draft", revisions: [{ id: "draft", revision: 1, title: "Rotina", status: "DRAFT", content: JSON.parse(JSON.stringify(text)), version: 3, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z", createdBy: user.id, updatedBy: user.id }] } }; }
const suggestion: HospitalAiSuggestion = { id: "suggestion", documentId: "document", draftRevisionId: "draft", sourceDocumentVersion: 4, sourceDraftVersion: 3, sourceContentHash: "synthetic-hash", requestedBy: user.id, createdAt: "2026-10-11T12:00:00Z", provider: "synthetic", model: "test-model", remoteReceiptId: "receipt", content: JSON.parse(JSON.stringify(text)), status: "PENDING_REVIEW", version: 2 };
const credential: HospitalIntegrationCredentialView = { id: "credential", name: "Conector autorizado", system: "HIS", purpose: "HIS_INTAKE", actorUserId: user.id, scope: { departmentCodes: ["INPATIENT"] }, active: true, expiresAt: "2026-10-12T12:00:00Z", createdAt: "2026-10-11T12:00:00Z", createdBy: user.id, version: 6 };
const receipt: HospitalIntegrationReceipt = { id: "message", messageId: "MSG-1", system: "HIS", purpose: "HIS_INTAKE", externalEntityId: "EXT-1", sequence: 1, direction: "OUTBOUND", status: "FAILED", attempts: 1, retryable: true, errorCode: "REMOTE_UNAVAILABLE", createdAt: "2026-10-11T12:00:00Z", version: 9 };
let configured = true; let suggestions: HospitalAiSuggestion[] = [];
beforeEach(() => { configured = true; suggestions = []; vi.mocked(apiFetch).mockImplementation(async (path, init) => {
  if (path === "/session/me") return { user } as never;
  if (path === "/hospital-assistance/capability") return { configured, provider: "synthetic", model: "test-model", requiresHumanReview: true, deploymentVerified: false } as never;
  if (path === "/hospital-documents/document/assistance") return init?.method ? suggestion as never : suggestions as never;
  if (path === "/hospital-integrations/capabilities") return [{ system: "HIS", contract: "CVG_OPERATIONAL_V1", configured, deploymentVerified: false }] as never;
  if (path === "/hospital-integrations/HIS/options") return { departments: [{ code: "INPATIENT", name: "Internação" }], actors: [{ id: user.id, displayName: user.displayName, departmentCode: "INPATIENT" }] } as never;
  if (path === "/hospital-integration-credentials") return init?.method ? { credential, token: "synthetic-service-token", tokenReturnedOnce: true } as never : [credential] as never;
  if (path.startsWith("/hospital-integrations/messages?")) return uiPage([receipt]) as never;
  if (path.startsWith("/hospital-intakes?")) return uiPage([{ id: "intake", title: "Demanda existente", version: 7 }]) as never;
  if (path === "/hospital-integrations/exchange") return { ...receipt, status: "SUCCEEDED", remoteReceiptId: "REAL-ACK" } as never;
  if (path === "/hospital-integrations/messages/message/retry") return { ...receipt, status: "CLAIMED" } as never;
  throw new Error(`Unexpected synthetic external path ${path}`);
}); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("queries HIS v4 discovery only on request and labels advertised capabilities without claiming deployment validation", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => path === "/hospital-integrations/his-v4/catalog" ? { profile: "HIS_V4", accountId: "ACCOUNT-SYNTHETIC", observedAt: "2026-10-11T12:00:00Z", contractReference: "HISv4", deploymentVerified: false, advertised: [{ family: "encounters", endpoints: ["/api/v4/encounters"], capabilities: ["webhook.v2"] }] } as never : original(path, init));
  render(<HospitalHisV4Discovery user={user} disabled={false} />); expect(apiFetch).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Consultar catálogo anunciado pelo HIS v4" })); await screen.findByText(/ACCOUNT-SYNTHETIC/); expect(screen.getByText(/Capacidades anunciadas: webhook.v2/)).toBeInTheDocument(); expect(screen.getByText(/Homologação externa ainda não comprovada/)).toBeInTheDocument(); expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true); act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); expect(apiFetch).toHaveBeenCalledOnce();
});
it("keeps HIS v4 discovery unavailable on missing configuration and emits only an explicitly selected profile", async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path === "/hospital-integrations/his-v4/catalog") throw new ApiClientError(503, { error: { code: "INTEGRATION_DISABLED" } }); return original(path, init); }); const first = render(<HospitalHisV4Discovery user={user} disabled={false} />); fireEvent.click(screen.getByRole("button", { name: "Consultar catálogo anunciado pelo HIS v4" })); await screen.findByRole("alert"); expect(screen.queryByText(/observado em/)).not.toBeInTheDocument(); first.unmount(); render(<HospitalIntegrationConsole />); await waitFor(() => expect(screen.getByLabelText("Ator elegível da credencial")).toHaveTextContent(user.displayName)); fireEvent.change(screen.getByLabelText("Perfil do contrato"), { target: { value: "HIS_V4" } }); fireEvent.change(screen.getByLabelText("Nome da credencial"), { target: { value: "HIS v4 autorizado" } }); fireEvent.change(screen.getByLabelText("Ator elegível da credencial"), { target: { value: user.id } }); fireEvent.click(screen.getByRole("checkbox", { name: "Internação" })); fireEvent.submit(screen.getByRole("form", { name: "Emitir credencial de integração" })); await screen.findByLabelText("Token retornado nesta emissão"); const write = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method)!; expect(JSON.parse(write[1]!.body as string)).toMatchObject({ profile: "HIS_V4", system: "HIS", purpose: "HIS_INTAKE" }); fireEvent.change(screen.getByLabelText("Sistema da credencial"), { target: { value: "LIS" } }); expect(screen.queryByLabelText("Perfil do contrato")).not.toBeInTheDocument();
});
it("shows disabled assistance without a simulated suggestion or transmission", async () => { configured = false; render(<HospitalDocumentAssistance user={user} view={documentView()} readOnly={false} onChanged={vi.fn()} />); await screen.findByText(/Assistência desativada/); expect(screen.queryByRole("form", { name: "Solicitar assistência de texto" })).not.toBeInTheDocument(); expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method)).toBe(true); });
it("requires explicit transmission confirmation and sends both current document versions", async () => { render(<HospitalDocumentAssistance user={user} view={documentView()} readOnly={false} onChanged={vi.fn()} />); const form = await screen.findByRole("form", { name: "Solicitar assistência de texto" }); fireEvent.change(screen.getByLabelText("Instrução operacional"), { target: { value: "Revisar clareza" } }); fireEvent.submit(form); expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false); fireEvent.click(screen.getByRole("checkbox", { name: /Confirmo a transmissão/ })); fireEvent.submit(form); await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/hospital-documents/document/assistance", expect.objectContaining({ method: "POST" }))); expect(JSON.parse(vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method)![1]!.body as string)).toEqual({ confirmTransmission: true, instruction: "Revisar clareza", expectedVersion: 4, expectedDraftVersion: 3 }); });
it("prevents applying stale assistance while allowing explicit human rejection and never approving the document", async () => { suggestions = [suggestion]; const view = documentView(); view.document.version = 5; view.document.revisions[0].version = 4; const changed = vi.fn(); const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => path.endsWith("/review") ? { ...suggestion, status: "REJECTED" } as never : original(path, init)); render(<HospitalDocumentAssistance user={user} view={view} readOnly={false} onChanged={changed} />); await screen.findByText(/O rascunho mudou/); expect(screen.getByRole("option", { name: "Aplicar somente ao rascunho" })).toBeDisabled(); fireEvent.change(screen.getByLabelText("Motivo da revisão humana"), { target: { value: "Fonte desatualizada" } }); fireEvent.click(screen.getByRole("checkbox", { name: /Revisei o texto/ })); fireEvent.submit(screen.getByRole("form", { name: "Revisar sugestão de texto" })); await waitFor(() => expect(changed).toHaveBeenCalledOnce()); const call = vi.mocked(apiFetch).mock.calls.find(([path]) => path.endsWith("/review"))!; expect(JSON.parse(call[1]!.body as string)).toEqual({ decision: "REJECT", confirm: true, reason: "Fonte desatualizada", expectedVersion: 2, expectedDocumentVersion: 5, expectedDraftVersion: 4 }); expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.endsWith("/approve"))).toBe(false); });
it("retains the human review reason after a version conflict", async () => { suggestions = [suggestion]; const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path.endsWith("/review")) throw new ApiClientError(409, { error: { code: "STALE_VERSION" } }); return original(path, init); }); render(<HospitalDocumentAssistance user={user} view={documentView()} readOnly={false} onChanged={vi.fn()} />); await screen.findByRole("form", { name: "Revisar sugestão de texto" }); fireEvent.change(screen.getByLabelText("Motivo da revisão humana"), { target: { value: "Razão não salva" } }); fireEvent.click(screen.getByRole("checkbox", { name: /Revisei o texto/ })); fireEvent.submit(screen.getByRole("form", { name: "Revisar sugestão de texto" })); await screen.findByRole("alert"); expect(screen.getByLabelText("Motivo da revisão humana")).toHaveValue("Razão não salva"); });
it("keeps unconfigured transport disabled and distinguishes configuration from external homologation", async () => { configured = false; render(<HospitalIntegrationConsole />); await screen.findByText(/Desativada: configuração ausente/); expect(screen.getByRole("button", { name: "Emitir token de serviço" })).toBeDisabled(); expect(screen.queryByRole("form", { name: "Transmitir origem autorizada" })).not.toBeInTheDocument(); expect(screen.getByText(/A instalação ainda precisa de homologação/)).toBeInTheDocument(); });
it("issues a credential from lightweight authorized options, carries its scope and removes the one-time token on close", async () => { render(<HospitalIntegrationConsole />); await waitFor(() => expect(screen.getByLabelText("Ator elegível da credencial")).toHaveTextContent(user.displayName)); fireEvent.change(screen.getByLabelText("Nome da credencial"), { target: { value: "Conector teste" } }); fireEvent.change(screen.getByLabelText("Ator elegível da credencial"), { target: { value: user.id } }); fireEvent.click(screen.getByRole("checkbox", { name: "Internação" })); fireEvent.submit(screen.getByRole("form", { name: "Emitir credencial de integração" })); const token = await screen.findByLabelText("Token retornado nesta emissão"); expect(token).toHaveAttribute("type", "password"); expect(token).toHaveValue("synthetic-service-token"); const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === "POST")!; expect(JSON.parse(call[1]!.body as string)).toMatchObject({ system: "HIS", purpose: "HIS_INTAKE", actorUserId: user.id, scope: { departmentCodes: ["INPATIENT"] } }); expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === "/users")).toBe(false); fireEvent.click(screen.getByRole("button", { name: "Fechar emissão e remover token da tela" })); expect(screen.queryByLabelText("Token retornado nesta emissão")).not.toBeInTheDocument(); });
it("transmits only a selected real source version and preserves failed receipts for explicit retry", async () => { render(<HospitalIntegrationConsole />); const form = await screen.findByRole("form", { name: "Transmitir origem autorizada" }); await waitFor(() => expect(screen.getByLabelText("Origem autorizada")).toHaveTextContent("Demanda existente")); fireEvent.change(screen.getByLabelText("Origem autorizada"), { target: { value: "intake" } }); fireEvent.change(screen.getByLabelText("Identificador externo da mensagem"), { target: { value: "MSG-NEW" } }); fireEvent.change(screen.getByLabelText("Identificador da entidade no sistema externo"), { target: { value: "EXT-NEW" } }); fireEvent.submit(form); expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === "/hospital-integrations/exchange")).toBe(false); fireEvent.click(screen.getByRole("checkbox", { name: /Confirmo o envio/ })); fireEvent.submit(form); await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/hospital-integrations/exchange", expect.objectContaining({ method: "POST" }))); const call = vi.mocked(apiFetch).mock.calls.find(([path]) => path === "/hospital-integrations/exchange")!; expect(JSON.parse(call[1]!.body as string)).toMatchObject({ targetType: "HOSPITAL_INTAKE", targetId: "intake", expectedVersion: 7 }); fireEvent.click(screen.getByRole("button", { name: "Repetir mensagem com falha" })); await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/hospital-integrations/messages/message/retry", expect.objectContaining({ body: JSON.stringify({ expectedVersion: 9 }) }))); });
it("clears capability-backed credential content after a current access denial", async () => { let denied = false; const original = vi.mocked(apiFetch).getMockImplementation()!; vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (denied && path === "/hospital-integrations/capabilities") throw new ApiClientError(403, { error: { code: "FORBIDDEN" } }); return original(path, init); }); render(<HospitalIntegrationConsole />); await screen.findByText("Conector autorizado"); denied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); await waitFor(() => expect(screen.queryByRole("button", { name: "Emitir token de serviço" })).not.toBeInTheDocument()); expect(screen.queryByRole("form", { name: "Transmitir origem autorizada" })).not.toBeInTheDocument(); expect(screen.queryByRole("heading", { name: "Conector autorizado" })).not.toBeInTheDocument(); });

it("removes a one-time token and credential data after the capabilities read refuses current access", async () => {
  let denied = false; const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (denied && path === "/hospital-integrations/capabilities") throw new ApiClientError(403, { error: { code: "SCOPE_DENIED" } }); return read(path, init); });
  render(<HospitalIntegrationConsole />);
  await waitFor(() => expect(screen.getByLabelText("Ator elegível da credencial")).toHaveTextContent(user.displayName));
  fireEvent.change(screen.getByLabelText("Nome da credencial"), { target: { value: "Conector restrito" } });
  fireEvent.change(screen.getByLabelText("Ator elegível da credencial"), { target: { value: user.id } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Internação" }));
  fireEvent.submit(screen.getByRole("form", { name: "Emitir credencial de integração" }));
  await screen.findByLabelText("Token retornado nesta emissão");
  denied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
  await screen.findByRole("button", { name: "Tentar novamente" });
  expect(screen.queryByLabelText("Token retornado nesta emissão")).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Conector autorizado" })).not.toBeInTheDocument();
});

it("rotates a captured credential version, manages the new one-time token and revokes it with a reason", async () => {
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path.endsWith("/rotate") ? { credential: { ...credential, version: 7 }, token: "rotated-synthetic-token", tokenReturnedOnce: true } as never : path.endsWith("/revoke") ? { ...credential, active: false, version: 7 } as never : read(path, init));
  const copy = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  render(<HospitalIntegrationConsole />);
  fireEvent.click(await screen.findByRole("button", { name: "Rotacionar credencial" }));
  fireEvent.change(screen.getByLabelText("Nova validade em segundos"), { target: { value: "3600" } });
  fireEvent.submit(screen.getByRole("form", { name: "Mudar credencial de integração" }));
  const token = await screen.findByLabelText("Token retornado nesta emissão");
  fireEvent.click(screen.getByRole("button", { name: "Mostrar token" })); expect(token).toHaveAttribute("type", "text");
  fireEvent.click(screen.getByRole("button", { name: "Ocultar token" })); expect(token).toHaveAttribute("type", "password");
  fireEvent.click(screen.getByRole("button", { name: "Copiar token uma vez" }));
  await screen.findByText("Token copiado para configurar o sistema autorizado.");
  expect(copy).toHaveBeenCalledWith("rotated-synthetic-token");
  fireEvent.click(screen.getByRole("button", { name: "Fechar emissão e remover token da tela" }));
  fireEvent.click(screen.getByRole("button", { name: "Revogar credencial" }));
  const form = screen.getByRole("form", { name: "Mudar credencial de integração" });
  fireEvent.submit(form);
  expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path.endsWith("/revoke"))).toHaveLength(0);
  fireEvent.change(within(form).getByLabelText("Motivo da revogação da credencial"), { target: { value: "  Rotação finalizada  " } });
  fireEvent.submit(form);
  await waitFor(() => expect(screen.queryByRole("form", { name: "Mudar credencial de integração" })).not.toBeInTheDocument());
  const commands = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method);
  expect(JSON.parse(commands[0][1]!.body as string)).toEqual({ ttlSeconds: 3600, expectedVersion: 6 });
  expect(JSON.parse(commands[1][1]!.body as string)).toEqual({ reason: "Rotação finalizada", expectedVersion: 6 });
});

it("does not reconstruct a previously returned token and keeps a failed copy available for manual selection", async () => {
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  let tokenReturned = true;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path.endsWith("/rotate") ? { credential, ...(tokenReturned ? { token: "synthetic-token-once" } : {}), tokenReturnedOnce: tokenReturned } as never : read(path, init));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("clipboard unavailable")) } });
  render(<HospitalIntegrationConsole />);
  fireEvent.click(await screen.findByRole("button", { name: "Rotacionar credencial" }));
  fireEvent.submit(screen.getByRole("form", { name: "Mudar credencial de integração" }));
  await screen.findByLabelText("Token retornado nesta emissão");
  fireEvent.click(screen.getByRole("button", { name: "Copiar token uma vez" }));
  await screen.findByText("Selecione o token para copiar manualmente.");
  tokenReturned = false;
  fireEvent.click(screen.getByRole("button", { name: "Rotacionar credencial" }));
  fireEvent.submit(screen.getByRole("form", { name: "Mudar credencial de integração" }));
  await screen.findByText("O token já foi retornado anteriormente. Rotacione a credencial se precisar de outro.");
  expect(screen.queryByLabelText("Token retornado nesta emissão")).not.toBeInTheDocument();
});

it.each(["LIS", "PACS"] as const)("selects only the authorized diagnostic modality for an explicit %s transmission", async (system) => {
  const currentUser = { ...user, role: "VETERINARIAN" as const, permissions: [...permissions, "request.list", "item.view"] as Permission[] };
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  const item = { id: "lab-item", requestId: "request", status: "RESULT_DRAFTED", priority: "ROUTINE", workflowType: "LABORATORY", departmentCode: "LABORATORY", version: 8, dueAt: "2026-10-11T14:00:00Z", service: { id: "lab", code: "HEM", name: "Hemograma autorizado" } };
  vi.mocked(apiFetchWithMeta).mockResolvedValue({ data: [{ id: "request", requestCode: "EX-SYNTHETIC", priority: "ROUTINE", createdAt: "2026-10-11T12:00:00Z", patient: { id: "patient", displayName: "Paciente sintético", species: "Canino", externalId: "SYNTHETIC" }, items: [item, { ...item, id: "image-item", workflowType: "RADIOLOGY", departmentCode: "RADIOLOGY", version: 9, service: { id: "image", code: "RAD", name: "Imagem autorizada" } }] }], meta: { nextCursor: "more" } } as never);
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path === "/session/me" ? { user: currentUser } as never : path === "/hospital-integrations/capabilities" ? [{ system, configured: true, contract: "CVG_OPERATIONAL_V1", deploymentVerified: false }] as never : path.endsWith("/options") ? { departments: [], actors: [] } as never : read(path, init));
  render(<HospitalIntegrationConsole />);
  fireEvent.change(await screen.findByLabelText("Sistema para mensagens"), { target: { value: system } });
  const expected = system === "LIS" ? "Hemograma autorizado" : "Imagem autorizada";
  const hidden = system === "LIS" ? "Imagem autorizada" : "Hemograma autorizado";
  await screen.findByRole("option", { name: new RegExp(expected) });
  expect(screen.queryByRole("option", { name: new RegExp(hidden) })).not.toBeInTheDocument();
  const form = screen.getByRole("form", { name: "Transmitir origem autorizada" });
  fireEvent.click(within(form).getByRole("button", { name: "Mais origens autorizadas" }));
  await waitFor(() => expect(apiFetchWithMeta).toHaveBeenCalledWith("/diagnostic-requests?limit=50&cursor=more"));
  fireEvent.change(within(form).getByLabelText("Origem autorizada"), { target: { value: system === "LIS" ? "lab-item" : "image-item" } });
  fireEvent.change(within(form).getByLabelText("Identificador externo da mensagem"), { target: { value: "MSG-DIAG" } });
  fireEvent.change(within(form).getByLabelText("Identificador da entidade no sistema externo"), { target: { value: "ENTITY-DIAG" } });
  fireEvent.change(within(form).getByLabelText("Sequência externa"), { target: { value: "2" } });
  fireEvent.click(within(form).getByRole("checkbox", { name: /Confirmo o envio/ }));
  fireEvent.submit(form);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/hospital-integrations/exchange", expect.objectContaining({ method: "POST" })));
  const write = vi.mocked(apiFetch).mock.calls.find(([path]) => path === "/hospital-integrations/exchange")!;
  expect(JSON.parse(write[1]!.body as string)).toEqual({ system, targetType: "DIAGNOSTIC_ITEM", targetId: system === "LIS" ? "lab-item" : "image-item", messageId: "MSG-DIAG", externalEntityId: "ENTITY-DIAG", sequence: 2, expectedVersion: system === "LIS" ? 8 : 9 });
});

it("pages native intake sources and integration receipts independently and validates current credential fields", async () => {
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.startsWith("/hospital-intakes?")) return uiPage([{ id: path.includes("cursor=") ? "intake-next" : "intake", title: path.includes("cursor=") ? "Próxima demanda" : "Demanda existente", version: 7 }], path.includes("cursor=") ? undefined : "more-intakes") as never;
    if (path.startsWith("/hospital-integrations/messages?")) return uiPage([{ ...receipt, id: path.includes("cursor=") ? "next-receipt" : receipt.id, messageId: path.includes("cursor=") ? "NEXT-MESSAGE" : receipt.messageId }], path.includes("cursor=") ? undefined : "more-receipts") as never;
    return read(path, init);
  });
  render(<HospitalIntegrationConsole />);
  fireEvent.click(await screen.findByRole("button", { name: "Mais origens autorizadas" }));
  await screen.findByRole("option", { name: "Próxima demanda · versão 7" });
  fireEvent.click(screen.getByRole("button", { name: "Mais recibos de integração" }));
  await screen.findByText(/NEXT-MESSAGE/);
  const form = screen.getByRole("form", { name: "Emitir credencial de integração" });
  fireEvent.change(within(form).getByLabelText("Nome da credencial"), { target: { value: "  Conector validado  " } });
  fireEvent.change(within(form).getByLabelText("Validade em segundos"), { target: { value: "600" } });
  fireEvent.submit(form);
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
  fireEvent.change(within(form).getByLabelText("Ator elegível da credencial"), { target: { value: user.id } });
  fireEvent.click(within(form).getByLabelText("Internação"));
  fireEvent.click(within(form).getByLabelText("Internação"));
  fireEvent.submit(form);
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
  fireEvent.click(within(form).getByLabelText("Internação"));
  fireEvent.submit(form);
  await screen.findByLabelText("Token retornado nesta emissão");
  const write = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method)!;
  expect(JSON.parse(write[1]!.body as string)).toMatchObject({ name: "Conector validado", ttlSeconds: 600, scope: { departmentCodes: ["INPATIENT"] } });
});

it("keeps the issued token during a transient refresh, blocks mutation and clears it after an authoritative refusal", async () => {
  let failure = 0; const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (failure && path === "/hospital-integrations/capabilities") throw new ApiClientError(failure, { error: { code: "SOURCE_UNAVAILABLE" } }); return read(path, init); });
  render(<HospitalIntegrationConsole />);
  await waitFor(() => expect(screen.getByLabelText("Ator elegível da credencial")).toHaveTextContent(user.displayName));
  fireEvent.change(screen.getByLabelText("Ator elegível da credencial"), { target: { value: user.id } });
  fireEvent.click(screen.getByLabelText("Internação"));
  fireEvent.submit(screen.getByRole("form", { name: "Emitir credencial de integração" }));
  await screen.findByLabelText("Token retornado nesta emissão");
  failure = 503; act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
  await waitFor(() => expect(screen.getByRole("button", { name: "Emitir token de serviço" })).toBeDisabled());
  expect(screen.getByLabelText("Token retornado nesta emissão")).toHaveValue("synthetic-service-token");
  failure = 403; act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
  await waitFor(() => expect(screen.queryByLabelText("Token retornado nesta emissão")).not.toBeInTheDocument());
});

it("describes invalid configuration, revoked credentials and native receipts without offering unauthorized changes", async () => {
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path === "/hospital-integrations/capabilities" ? [{ system: "HIS", configured: false, reason: "CONFIGURATION_INVALID" }] as never : path === "/hospital-integration-credentials" ? [{ ...credential, profile: "HIS_V4", active: false }] as never : path.startsWith("/hospital-integrations/messages?") ? uiPage([{ ...receipt, id: "received", direction: "INBOUND", status: "SUCCEEDED", retryable: false }, { ...receipt, id: "claimed", status: "CLAIMED", retryable: false }]) as never : read(path, init));
  render(<HospitalIntegrationConsole />);
  await screen.findByText(/Configuração inválida/);
  await screen.findByText(/Comando nativo confirmado/);
  await screen.findByText(/Em processamento/);
  expect(screen.queryByRole("button", { name: "Rotacionar credencial" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Repetir mensagem com falha" })).not.toBeInTheDocument();
});

it("does not load integration details without a grant and removes all sections after the session expires", async () => {
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  let expired = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => path === "/session/me" ? expired ? Promise.reject(new ApiClientError(401, { error: { code: "AUTH_REQUIRED" } })) : { user: { ...user, permissions: [] } } as never : read(path, init));
  render(<HospitalIntegrationConsole />);
  await screen.findByText("Integrações fora do seu acesso");
  expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toEqual(["/session/me"]);
  expired = true; act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
  await screen.findByText("Integrações indisponíveis");
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
});

it("scopes an advertised HIS catalog to its current reader and ignores an aborted previous identity's reply", async () => {
  let finishOld!: (value: unknown) => void;
  vi.mocked(apiFetch).mockImplementation(async () => new Promise<unknown>((resolve) => { finishOld = resolve; }) as never);
  const rendered = render(<HospitalHisV4Discovery user={user} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Consultar catálogo anunciado pelo HIS v4" }));
  await waitFor(() => expect(finishOld).toBeDefined());
  rendered.rerender(<HospitalHisV4Discovery user={{ ...user, id: "another-admin" }} disabled={false} />);
  await act(async () => finishOld({ profile: "HIS_V4", accountId: "OLD-PRIVATE-ACCOUNT", observedAt: "2026-10-11T12:00:00Z", contractReference: "HISv4", deploymentVerified: false, advertised: [] }));
  expect(screen.queryByText(/OLD-PRIVATE-ACCOUNT/)).not.toBeInTheDocument();
  vi.mocked(apiFetch).mockResolvedValue({ profile: "HIS_V4", accountId: "CURRENT-ACCOUNT", observedAt: "2026-10-11T12:00:00Z", contractReference: "HISv4", deploymentVerified: false, advertised: [{ family: "empty-family", provider: "Hospital", endpoints: [], capabilities: [] }] } as never);
  fireEvent.click(screen.getByRole("button", { name: "Consultar catálogo anunciado pelo HIS v4" }));
  await screen.findByText(/CURRENT-ACCOUNT/);
  expect(screen.getByText("empty-family · Hospital")).toBeInTheDocument();
  expect(screen.getByText("Capacidades anunciadas: Nenhuma informada")).toBeInTheDocument();
  vi.mocked(apiFetch).mockResolvedValue({ profile: "HIS_V4", accountId: "CURRENT-ACCOUNT", observedAt: "2026-10-11T12:00:00Z", contractReference: "HISv4", deploymentVerified: false, advertised: [] } as never);
  fireEvent.click(screen.getByRole("button", { name: "Consultar catálogo anunciado pelo HIS v4" }));
  await screen.findByText("Nenhuma capacidade anunciada no catálogo retornado.");
  rendered.rerender(<HospitalHisV4Discovery user={user} disabled />);
  const calls = vi.mocked(apiFetch).mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Consultar catálogo anunciado pelo HIS v4" }));
  expect(vi.mocked(apiFetch).mock.calls).toHaveLength(calls);
  rendered.rerender(<HospitalHisV4Discovery user={{ ...user, permissions: [] }} disabled={false} />);
  expect(screen.queryByRole("heading")).not.toBeInTheDocument();
});
