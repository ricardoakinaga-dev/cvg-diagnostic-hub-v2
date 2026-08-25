/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function mockReads(data: { result: { id: string }; version: unknown }, calls: Array<[string, RequestInit | undefined]>) {
  return vi.spyOn(apiClient, "apiFetch").mockImplementation((path, init) => {
    calls.push([path, init]);
    if (path === `/results/${data.result.id}`) return Promise.resolve(data) as never;
    if (path === `/results/${data.result.id}/versions`) return Promise.resolve([data.version]) as never;
    if (path === `/reports/${data.result.id}`) return Promise.resolve({ attachments: [] }) as never;
    if (path.endsWith("/view")) return Promise.resolve({}) as never;
    if (path.endsWith("/amend") || path.endsWith("/draft") || path.endsWith("/release")) return Promise.resolve({}) as never;
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
});
