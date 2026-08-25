/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandCenterPanel, type CommandCenterData } from "./command-center-panel";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>
}));

const data: CommandCenterData = {
  updatedAt: "2026-08-25T09:00:00.000Z",
  dataQuality: { status: "FRESH", asOf: "2026-08-25T09:00:00.000Z" },
  departments: [{ departmentCode: "LABORATORY", label: "Laboratório", activeItems: 2, overdue: 1, attention: 1, state: "ATTENTION" }],
  attention: [{
    id: "item-1",
    requestId: "request-1",
    requestCode: "EX-0001",
    patient: { id: "patient-1", displayName: "Thor", species: "Canino", externalId: "HIS-THOR" },
    service: { id: "service-1", name: "Hemograma", workflowType: "LABORATORY" },
    departmentCode: "LABORATORY",
    status: "REQUESTED",
    priority: "URGENT",
    dueAt: "2026-08-25T12:00:00.000Z",
    overdue: false,
    nextAction: "Receber amostra",
    operationalContext: {
      currentOwner: { code: "REQUESTING_TEAM", label: "Equipe solicitante · INPATIENT" },
      nextAction: { code: "COLLECT_SAMPLE", label: "Receber amostra" },
      blockedBy: { code: "WAITING_SAMPLE", label: "Aguardando amostra" },
      waitingSince: "2026-08-25T08:00:00.000Z",
      expectedBy: "2026-08-25T12:00:00.000Z",
      escalationLevel: "ATTENTION"
    },
    deepLink: "/requests/request-1#item-1"
  }]
};

describe("CommandCenterPanel", () => {
  it("places the server-derived next action, owner and blocker in the attention row", () => {
    render(<CommandCenterPanel data={data} />);

    expect(screen.getByRole("heading", { name: "Atenção primeiro" })).toBeInTheDocument();
    expect(screen.getByText("Thor")).toBeInTheDocument();
    expect(screen.getByText("Receber amostra")).toBeInTheDocument();
    expect(screen.getByText("Equipe solicitante · INPATIENT · Aguardando amostra")).toBeInTheDocument();
    expect(screen.getByText("Laboratório")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Thor/ })).toHaveAttribute("href", "/requests/request-1#item-1");
  });

  it("communicates a fresh empty state and keeps the queue path available", () => {
    render(<CommandCenterPanel data={{ dataQuality: { status: "FRESH", asOf: "2026-08-25T09:00:00.000Z" }, attention: [], departments: [] }} />);

    expect(screen.getByText("Nenhum item requer atenção imediata")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Abrir central/ })).toHaveAttribute("href", "/queues");
  });
});
