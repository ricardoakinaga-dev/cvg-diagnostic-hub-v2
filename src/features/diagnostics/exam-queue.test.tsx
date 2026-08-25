/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExamQueue } from "./exam-queue";
import * as apiClient from "@/components/api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>
}));

const item = {
  id: "item-1",
  requestId: "request-1",
  status: "REQUESTED" as const,
  workflowType: "LABORATORY" as const,
  priority: "URGENT" as const,
  version: 1,
  dueAt: "2026-08-25T12:00:00.000Z",
  createdAt: "2026-08-25T08:00:00.000Z",
  requestCode: "EX-0001",
  nextAction: "Receber amostra",
  overdue: false,
  patient: { id: "patient-1", displayName: "Thor", species: "Canino", externalId: "HIS-THOR" },
  service: { id: "service-1", code: "HEMOGRAM", name: "Hemograma" },
  operationalContext: {
    currentOwner: { code: "REQUESTING_TEAM" as const, label: "Equipe solicitante · INPATIENT" },
    nextAction: { code: "COLLECT_SAMPLE" as const, label: "Receber amostra" },
    blockedBy: { code: "WAITING_SAMPLE" as const, label: "Aguardando amostra" },
    waitingSince: "2026-08-25T08:00:00.000Z",
    expectedBy: "2026-08-25T12:00:00.000Z",
    escalationLevel: "WATCH" as const
  }
};

describe("ExamQueue", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("opens a contextual drawer without leaving the queue and closes it with Escape", async () => {
    const fetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { role: "LAB_TECH", departmentCode: "LABORATORY" } }) as never;
      if (path.startsWith("/queues/LABORATORY/items")) return Promise.resolve([item]) as never;
      return Promise.reject(new Error(`unexpected request: ${path}`)) as never;
    });

    render(<ExamQueue />);
    expect(await screen.findByText("Thor")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/queues/LABORATORY/items");
    const opener = screen.getByRole("button", { name: "Abrir contexto de Hemograma" });
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Hemograma" });
    expect(dialog).toBeInTheDocument();
    const closeButton = within(dialog).getByRole("button", { name: "Fechar contexto" });
    expect(closeButton).toHaveFocus();
    expect(within(dialog).getByText("Equipe solicitante · INPATIENT")).toBeInTheDocument();
    expect(within(dialog).getByText("Aguardando amostra")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /Abrir workspace completo/ })).toHaveAttribute("href", "/requests/request-1#item-1");

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(within(dialog).getByRole("link", { name: /Abrir workspace completo/ })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Hemograma" })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
