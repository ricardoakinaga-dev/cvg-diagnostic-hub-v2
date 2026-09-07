/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResultView } from "./result-view";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>
}));

const released = {
  result: { id: "result-1", lifecycleStatus: "RELEASED", needsReReview: false, version: 4 },
  version: { id: "version-1", sequence: 1, status: "RELEASED" as const, narrative: "Resultado clínico confirmado.", conclusion: "Sem alterações.", authorId: "user-lab", createdAt: "2026-08-23T12:00:00.000Z", releasedAt: "2026-08-23T12:05:00.000Z", critical: false, needsReReview: false, version: 2, content: { value: 7 } },
  item: { id: "item-1", status: "RESULT_AVAILABLE" as const, version: 5, serviceId: "service-xray" },
  request: { id: "request-1", requestCode: "EX-260823-0001" },
  patient: { displayName: "Thor", species: "Canino", sex: "Macho", externalId: "HIS-THOR-001" },
  service: { name: "RX de tórax", workflowType: "RADIOLOGY" as const, allowsAttachment: true }
};

const draft = {
  ...released,
  result: { ...released.result, lifecycleStatus: "DRAFT", version: 1 },
  version: { ...released.version, id: "version-draft", status: "DRAFT" as const, releasedAt: undefined, version: 1 },
  item: { ...released.item, status: "IN_PROGRESS" as const, version: 2 }
};

const attachment = { id: "attachment-1", safeName: "laudo.pdf", detectedMime: "application/pdf", sizeBytes: 5, scanStatus: "CLEAN", uploadStatus: "FINALIZED" };
type Attachment = typeof attachment;

const laboratoryDraft = {
  ...draft,
  version: { ...draft.version, narrative: "Resultado inicial.", content: { kind: "LABORATORY_STRUCTURED", panelCode: "SYNTHETIC_HEMOGRAM", panelVersion: 1, observations: [] } },
  service: {
    name: "Hemograma",
    workflowType: "LABORATORY" as const,
    resultSchema: "NUMERIC_PANEL" as const,
    allowsAttachment: true,
    resultTemplate: {
      kind: "LABORATORY_PANEL" as const,
      code: "SYNTHETIC_HEMOGRAM",
      name: "Hemograma sintético de demonstração",
      version: 1,
      schemaVersion: "1.0",
      status: "ACTIVE" as const,
      analytes: [
        { code: "HEMOGLOBIN", label: "Hemoglobina", valueType: "NUMERIC" as const, unitCode: "g/dL", required: true, displayOrder: 1, referenceRange: { kind: "PENDING_POLICY" as const, unitCode: "g/dL", source: "PENDING_HUMAN_POLICY" as const, note: "Aguardando aprovação clínica." } },
        { code: "COMMENT", label: "Observação", valueType: "TEXT" as const, unitCode: "TEXT", required: false, displayOrder: 2, referenceRange: { kind: "PENDING_POLICY" as const, unitCode: "TEXT", source: "PENDING_HUMAN_POLICY" as const, note: "Não aplicável." } }
      ]
    }
  }
};

function mockReads(data: { result: { id: string }; version: unknown }, calls: Array<[string, RequestInit | undefined]>, reportAttachments: Attachment[] = []) {
  return vi.spyOn(apiClient, "apiFetch").mockImplementation((path, init) => {
    calls.push([path, init]);
    if (path === `/results/${data.result.id}`) return Promise.resolve(data) as never;
    if (path === `/results/${data.result.id}/versions`) return Promise.resolve([data.version]) as never;
    if (path === `/reports/${data.result.id}`) return Promise.resolve({ attachments: reportAttachments }) as never;
    if (path.endsWith("/view")) return Promise.resolve({}) as never;
    if (path.endsWith("/amend") || path.endsWith("/draft") || path.endsWith("/release") || path.endsWith("/review") || path.endsWith("/void")) return Promise.resolve({}) as never;
    return Promise.reject(new Error(`unexpected request ${path}`)) as never;
  });
}

describe("ResultView clinical lifecycle actions", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("submits an emenda with the current result version and a mandatory reason", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    mockReads(released, calls);
    render(<ResultView resultId="result-1" />);

    expect(await screen.findByText("Resultado clínico confirmado.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Emendar resultado" }));
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Correção de unidade" } });
    fireEvent.change(screen.getByLabelText("Narrativa"), { target: { value: "Resultado corrigido." } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() => expect(calls.some(([path]) => path === "/results/result-1/amend")).toBe(true));
    const amend = calls.find(([path]) => path === "/results/result-1/amend");
    expect(JSON.parse(amend?.[1]?.body as string)).toMatchObject({ reason: "Correção de unidade", narrative: "Resultado corrigido.", expectedVersion: 4 });
  });

  it("uploads a draft attachment with the SHA-256 digest and finalizes the session", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async () => Uint8Array.from([0xab, 0xcd]).buffer) } });
    const mock = mockReads(draft, calls);
    mock.mockImplementation((path, init) => {
      calls.push([path, init]);
      if (path === "/results/result-1") return Promise.resolve(draft) as never;
      if (path === "/results/result-1/versions") return Promise.resolve([draft.version]) as never;
      if (path === "/reports/result-1") return Promise.resolve({ attachments: [] }) as never;
      if (path === "/result-versions/version-draft/attachments/upload-session") return Promise.resolve({ attachment, uploadUrl: "/api/v1/attachments/attachment-1/content", expiresAt: "2026-08-23T13:00:00.000Z" }) as never;
      if (path === "/attachments/attachment-1/content") return Promise.resolve({ attachment }) as never;
      if (path === "/attachments/attachment-1/finalize") return Promise.resolve({ attachment }) as never;
      return Promise.reject(new Error(`unexpected request ${path}`)) as never;
    });
    render(<ResultView resultId="result-1" />);

    await screen.findByText("Draft em edição");
    const file = new File(["%PDF-"], "laudo.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Adicionar anexo (PDF, JPEG ou PNG)"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar anexo" }));

    await waitFor(() => expect(calls.some(([path]) => path === "/attachments/attachment-1/finalize")).toBe(true));
    const session = calls.find(([path]) => path === "/result-versions/version-draft/attachments/upload-session");
    expect(JSON.parse(session?.[1]?.body as string)).toMatchObject({ checksum: "abcd", sizeBytes: 5, expectedVersion: 1 });
    expect(calls.some(([path]) => path === "/attachments/attachment-1/content")).toBe(true);
  });

  it("keeps a draft usable when the protected history read hides the current draft", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path, init) => {
      calls.push([path, init]);
      if (path === "/results/result-1") return Promise.resolve(draft) as never;
      if (path === "/results/result-1/versions") return Promise.reject(new Error("draft history is not visible")) as never;
      if (path === "/reports/result-1") return Promise.resolve({ attachments: [] }) as never;
      return Promise.reject(new Error(`unexpected request ${path}`)) as never;
    });

    render(<ResultView resultId="result-1" />);

    await screen.findByText("Draft em edição");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(calls.some(([path]) => path === "/results/result-1/versions")).toBe(true);
  });

  it("reconciles the visible result after a realtime update or resync event", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    mockReads(released, calls);
    render(<ResultView resultId="result-1" />);

    expect(await screen.findByText("Resultado clínico confirmado.")).toBeInTheDocument();
    const initialReads = calls.filter(([path]) => path === "/results/result-1").length;
    act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));

    await waitFor(() => expect(calls.filter(([path]) => path === "/results/result-1").length).toBeGreaterThan(initialReads));
    expect(screen.getByText("Atualização recebida; reconciliando o resultado com o servidor.")).toBeInTheDocument();
  });

  it("blocks a draft save when reconciliation detects a newer remote version", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    let current = draft;
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path, init) => {
      calls.push([path, init]);
      if (path === "/results/result-1") return Promise.resolve(current) as never;
      if (path === "/results/result-1/versions") return Promise.resolve([current.version]) as never;
      if (path === "/reports/result-1") return Promise.resolve({ attachments: [] }) as never;
      return Promise.reject(new Error(`unexpected request ${path}`)) as never;
    });
    render(<ResultView resultId="result-1" />);

    await screen.findByText("Draft em edição");
    fireEvent.click(screen.getByRole("button", { name: "Editar draft" }));
    await screen.findByRole("button", { name: "Confirmar" });
    current = { ...draft, result: { ...draft.result, version: 2 }, version: { ...draft.version, version: 2 } };
    act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("mudou em outra sessão"));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(calls.some(([path]) => path === "/results/result-1/draft")).toBe(false);
  });

  it("preserves a typed draft value while reconciliation refreshes the server copy", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    mockReads(draft, calls);
    render(<ResultView resultId="result-1" />);

    await screen.findByText("Draft em edição");
    fireEvent.click(screen.getByRole("button", { name: "Editar draft" }));
    const narrative = screen.getByLabelText("Narrativa");
    fireEvent.change(narrative, { target: { value: "Texto local ainda não salvo." } });
    act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));

    await waitFor(() => expect(calls.filter(([path]) => path === "/results/result-1").length).toBeGreaterThan(1));
    expect(narrative).toHaveValue("Texto local ainda não salvo.");
    expect(screen.queryByText("O resultado mudou em outra sessão. Feche o editor, reconcilie e reabra a versão antes de salvar.")).not.toBeInTheDocument();
  });

  it("does not treat the event from its own pending draft save as a remote conflict", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    let current = draft;
    let resolveDraft!: (value: unknown) => void;
    let patchStarted = false;
    const pendingDraft = new Promise((resolve) => { resolveDraft = resolve; });
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path, init) => {
      calls.push([path, init]);
      if (path === "/results/result-1") return Promise.resolve(current) as never;
      if (path === "/results/result-1/versions") return Promise.resolve([current.version]) as never;
      if (path === "/reports/result-1") return Promise.resolve({ attachments: [] }) as never;
      if (path === "/results/result-1/draft") {
        patchStarted = true;
        return pendingDraft as never;
      }
      return Promise.reject(new Error(`unexpected request ${path}`)) as never;
    });
    render(<ResultView resultId="result-1" />);

    await screen.findByText("Draft em edição");
    fireEvent.click(screen.getByRole("button", { name: "Editar draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(patchStarted).toBe(true));
    current = { ...draft, result: { ...draft.result, version: 2 }, version: { ...draft.version, version: 2 } };
    act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    expect(screen.queryByText("O resultado mudou em outra sessão. Feche o editor, reconcilie e reabra a versão antes de salvar.")).not.toBeInTheDocument();
    resolveDraft({});

    await waitFor(() => expect(screen.getByText("Draft atualizado.")).toBeInTheDocument());
    expect(screen.queryByText("O resultado mudou em outra sessão. Feche o editor, reconcilie e reabra a versão antes de salvar.")).not.toBeInTheDocument();
  });

  it("keeps the save confirmation when the post-save realtime event arrives", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    mockReads(draft, calls);
    render(<ResultView resultId="result-1" />);

    await screen.findByText("Draft em edição");
    fireEvent.click(screen.getByRole("button", { name: "Editar draft" }));
    fireEvent.change(screen.getByLabelText("Narrativa"), { target: { value: "Draft persistido." } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() => expect(screen.getByText("Draft atualizado.")).toBeInTheDocument());
    act(() => {
      window.dispatchEvent(new Event("cvg:realtime-updated"));
      window.dispatchEvent(new Event("cvg:realtime-updated"));
    });
    await waitFor(() => expect(calls.filter(([path]) => path === "/results/result-1").length).toBeGreaterThan(2));

    expect(screen.getByText("Draft atualizado.")).toBeInTheDocument();
  });

  it("keeps the newest reconciliation when an older realtime response resolves later", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    let resultReads = 0;
    let resolveOlder!: (value: unknown) => void;
    const olderResponse = new Promise((resolve) => { resolveOlder = resolve; });
    const newer = { ...released, result: { ...released.result, version: 6 }, version: { ...released.version, narrative: "Versão mais nova." } };
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path, init) => {
      calls.push([path, init]);
      if (path === "/results/result-1") {
        resultReads += 1;
        if (resultReads === 1) return Promise.resolve(released) as never;
        if (resultReads === 2) return olderResponse as never;
        return Promise.resolve(newer) as never;
      }
      if (path === "/results/result-1/versions") return Promise.resolve([newer.version]) as never;
      if (path === "/reports/result-1") return Promise.resolve({ attachments: [] }) as never;
      if (path.endsWith("/view")) return Promise.resolve({}) as never;
      return Promise.reject(new Error(`unexpected request ${path}`)) as never;
    });
    render(<ResultView resultId="result-1" />);

    expect(await screen.findByText("Resultado clínico confirmado.")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("cvg:realtime-updated"));
      window.dispatchEvent(new Event("cvg:realtime-updated"));
    });
    await waitFor(() => expect(screen.getByText("Versão mais nova.")).toBeInTheDocument());
    resolveOlder({ ...released, result: { ...released.result, version: 5 }, version: { ...released.version, narrative: "Resposta antiga." } });
    await waitFor(() => expect(screen.getByText("Versão mais nova.")).toBeInTheDocument());
    expect(screen.queryByText("Resposta antiga.")).not.toBeInTheDocument();
    expect(calls.filter(([path]) => path === "/results/result-1").length).toBe(3);
  });

  it("edits a laboratory panel with typed observations and preserves the pending-policy warning", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    mockReads(laboratoryDraft, calls);
    render(<ResultView resultId="result-1" />);

    expect(await screen.findByText("Hemograma sintético de demonstração")).toBeInTheDocument();
    expect(screen.getAllByText("Faixa pendente de aprovação").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Editar draft" }));
    fireEvent.change(screen.getByLabelText("Hemoglobina"), { target: { value: "12.4" } });
    fireEvent.change(screen.getByLabelText("Narrativa"), { target: { value: "Painel preenchido." } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() => expect(calls.some(([path]) => path === "/results/result-1/draft")).toBe(true));
    const update = calls.find(([path]) => path === "/results/result-1/draft");
    expect(JSON.parse(update?.[1]?.body as string)).toMatchObject({
      narrative: "Painel preenchido.",
      content: { kind: "LABORATORY_STRUCTURED", panelCode: "SYNTHETIC_HEMOGRAM", panelVersion: 1, observations: [{ analyteCode: "HEMOGLOBIN", value: 12.4, unitCode: "g/dL" }] }
    });
  });

  it("reviews a released result and requires a reason before invalidation", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    mockReads(released, calls);
    render(<ResultView resultId="result-1" />);

    await screen.findByText("Resultado clínico confirmado.");
    const reviewButton = await screen.findByRole("button", { name: "Marcar como revisado" });
    await waitFor(() => expect(reviewButton).not.toBeDisabled());
    fireEvent.click(reviewButton);
    await waitFor(() => expect(calls.some(([path]) => path === "/results/result-1/review")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Emendar resultado" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(screen.getByRole("button", { name: "Invalidar" }));
    fireEvent.submit(screen.getByRole("heading", { name: "Invalidar versão liberada" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Informe o motivo da invalidação");
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Laudo substituído" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(calls.some(([path]) => path === "/results/result-1/void")).toBe(true));
  });

  it("gives released attachment downloads distinct accessible names", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    mockReads(released, calls, [attachment, { ...attachment, id: "attachment-2", safeName: "imagem.png", detectedMime: "image/png" }]);
    render(<ResultView resultId="result-1" />);

    await screen.findByText("Resultado clínico confirmado.");

    expect(screen.getByRole("link", { name: "Baixar laudo.pdf" })).toHaveAttribute("href", "/api/v1/attachments/attachment-1/download");
    expect(screen.getByRole("link", { name: "Baixar imagem.png" })).toHaveAttribute("href", "/api/v1/attachments/attachment-2/download");
  });

  it("releases a narrative draft with an explicit critical flag", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    mockReads(draft, calls);
    render(<ResultView resultId="result-1" />);

    await screen.findByText("Draft em edição");
    fireEvent.click(screen.getByLabelText("Liberar como resultado crítico"));
    fireEvent.click(screen.getByRole("button", { name: "Liberar resultado" }));
    await waitFor(() => expect(calls.some(([path]) => path === "/results/result-1/release")).toBe(true));
    expect(JSON.parse(calls.find(([path]) => path === "/results/result-1/release")?.[1]?.body as string)).toMatchObject({ critical: true, expectedVersion: 1 });
  });

  it("announces a pending release and blocks duplicate submission", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    let resolveRelease!: (value: unknown) => void;
    const pendingRelease = new Promise((resolve) => { resolveRelease = resolve; });
    const mock = mockReads(draft, calls);
    mock.mockImplementation((path, init) => {
      calls.push([path, init]);
      if (path === "/results/result-1") return Promise.resolve(draft) as never;
      if (path === "/results/result-1/versions") return Promise.resolve([draft.version]) as never;
      if (path === "/reports/result-1") return Promise.resolve({ attachments: [] }) as never;
      if (path === "/results/result-1/release") return pendingRelease as never;
      return Promise.reject(new Error(`unexpected request ${path}`)) as never;
    });
    render(<ResultView resultId="result-1" />);

    await screen.findByText("Draft em edição");
    const releaseButton = screen.getByRole("button", { name: "Liberar resultado" });
    fireEvent.click(releaseButton);

    await waitFor(() => {
      expect(releaseButton).toHaveAttribute("data-action-state", "pending");
      expect(releaseButton).toHaveAttribute("aria-busy", "true");
      expect(releaseButton).toBeDisabled();
    });
    expect(calls.filter(([path]) => path === "/results/result-1/release")).toHaveLength(1);

    resolveRelease({});
    await waitFor(() => expect(releaseButton).toHaveAttribute("data-action-state", "idle"));
  });

  it("announces a pending editor save until the server confirms it", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    let resolveAmend!: (value: unknown) => void;
    const pendingAmend = new Promise((resolve) => { resolveAmend = resolve; });
    const mock = mockReads(released, calls);
    mock.mockImplementation((path, init) => {
      calls.push([path, init]);
      if (path === "/results/result-1") return Promise.resolve(released) as never;
      if (path === "/results/result-1/versions") return Promise.resolve([released.version]) as never;
      if (path === "/reports/result-1") return Promise.resolve({ attachments: [] }) as never;
      if (path.endsWith("/view")) return Promise.resolve({}) as never;
      if (path === "/results/result-1/amend") return pendingAmend as never;
      return Promise.reject(new Error(`unexpected request ${path}`)) as never;
    });
    render(<ResultView resultId="result-1" />);

    await screen.findByText("Resultado clínico confirmado.");
    fireEvent.click(screen.getByRole("button", { name: "Emendar resultado" }));
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Correção de unidade" } });
    fireEvent.change(screen.getByLabelText("Narrativa"), { target: { value: "Resultado corrigido." } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

    const savingButton = await screen.findByRole("button", { name: "Salvando…" });
    await waitFor(() => {
      expect(savingButton).toHaveAttribute("data-action-state", "pending");
      expect(savingButton).toHaveAttribute("aria-busy", "true");
      expect(savingButton).toBeDisabled();
    });
    expect(calls.filter(([path]) => path === "/results/result-1/amend")).toHaveLength(1);

    resolveAmend({});
    await waitFor(() => expect(screen.getByText("Emenda salva como nova versão em draft.")).toBeInTheDocument());
  });

  it("marks only the review action as pending while the server records it", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    let resolveReview!: (value: unknown) => void;
    const pendingReview = new Promise((resolve) => { resolveReview = resolve; });
    const mock = mockReads(released, calls);
    mock.mockImplementation((path, init) => {
      calls.push([path, init]);
      if (path === "/results/result-1") return Promise.resolve(released) as never;
      if (path === "/results/result-1/versions") return Promise.resolve([released.version]) as never;
      if (path === "/reports/result-1") return Promise.resolve({ attachments: [] }) as never;
      if (path.endsWith("/view")) return Promise.resolve({}) as never;
      if (path === "/results/result-1/review") return pendingReview as never;
      return Promise.reject(new Error(`unexpected request ${path}`)) as never;
    });
    render(<ResultView resultId="result-1" />);

    const reviewButton = await screen.findByRole("button", { name: "Marcar como revisado" });
    await waitFor(() => expect(reviewButton).not.toBeDisabled());
    fireEvent.click(reviewButton);

    await waitFor(() => {
      expect(reviewButton).toHaveAttribute("data-action-state", "pending");
      expect(reviewButton).toHaveAttribute("aria-busy", "true");
      expect(reviewButton).toBeDisabled();
    });
    expect(calls.filter(([path]) => path === "/results/result-1/review")).toHaveLength(1);

    resolveReview({});
    await waitFor(() => expect(screen.getByRole("button", { name: "Revisão registrada" })).toHaveAttribute("data-action-state", "idle"));
  });

  it("marks only the upload action as pending while bytes are transferred", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    let resolveUpload!: (value: unknown) => void;
    const pendingUpload = new Promise((resolve) => { resolveUpload = resolve; });
    vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async () => Uint8Array.from([0xab, 0xcd]).buffer) } });
    const mock = mockReads(draft, calls);
    mock.mockImplementation((path, init) => {
      calls.push([path, init]);
      if (path === "/results/result-1") return Promise.resolve(draft) as never;
      if (path === "/results/result-1/versions") return Promise.resolve([draft.version]) as never;
      if (path === "/reports/result-1") return Promise.resolve({ attachments: [] }) as never;
      if (path === "/result-versions/version-draft/attachments/upload-session") return Promise.resolve({ attachment, uploadUrl: "/api/v1/attachments/attachment-1/content", expiresAt: "2026-08-23T13:00:00.000Z" }) as never;
      if (path === "/attachments/attachment-1/content") return pendingUpload as never;
      if (path === "/attachments/attachment-1/finalize") return Promise.resolve({ attachment }) as never;
      return Promise.reject(new Error(`unexpected request ${path}`)) as never;
    });
    render(<ResultView resultId="result-1" />);

    await screen.findByText("Draft em edição");
    fireEvent.change(screen.getByLabelText("Adicionar anexo (PDF, JPEG ou PNG)"), { target: { files: [new File(["%PDF-"], "laudo.pdf", { type: "application/pdf" })] } });
    const uploadButton = screen.getByRole("button", { name: "Enviar anexo" });
    const releaseButton = screen.getByRole("button", { name: "Liberar resultado" });
    fireEvent.click(uploadButton);

    await waitFor(() => {
      expect(uploadButton).toHaveAttribute("data-action-state", "pending");
      expect(uploadButton).toHaveAttribute("aria-busy", "true");
      expect(uploadButton).toBeDisabled();
      expect(releaseButton).toHaveAttribute("data-action-state", "idle");
      expect(releaseButton).not.toHaveAttribute("aria-busy", "true");
    });
    await waitFor(() => expect(calls.filter(([path]) => path === "/result-versions/version-draft/attachments/upload-session")).toHaveLength(1));

    resolveUpload({ attachment });
    await waitFor(() => expect(uploadButton).toHaveAttribute("data-action-state", "idle"));
  });

  it("rejects an unsafe attachment before external I/O", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    mockReads(draft, calls);
    render(<ResultView resultId="result-1" />);

    await screen.findByText("Draft em edição");
    fireEvent.change(screen.getByLabelText("Adicionar anexo (PDF, JPEG ou PNG)"), { target: { files: [new File(["not-an-image"], "malware.exe", { type: "application/x-msdownload" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar anexo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Escolha um PDF, JPEG ou PNG");
    expect(calls.some(([path]) => path.includes("upload-session"))).toBe(false);
  });

  it("keeps a legacy laboratory draft visibly incomplete and without a release action", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    mockReads({ ...laboratoryDraft, version: { ...laboratoryDraft.version, content: {} } }, calls);
    render(<ResultView resultId="result-1" />);

    expect(await screen.findByText(/Este draft ainda usa conteúdo legado/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Liberar resultado" })).not.toBeInTheDocument();
  });
});
