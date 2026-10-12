import { describe, expect, it, vi } from "vitest";
import RootLayout from "./layout";
import HomePage from "./page";
import AccountPage from "./account/page";
import AdminPage from "./admin/page";
import IndicatorsPage from "./indicators/page";
import LoginPage from "./login/page";
import ManagementPage from "./management/page";
import NotificationsPage from "./notifications/page";
import PatientsPage from "./patients/page";
import PatientDiagnosticsPage from "./patients/[id]/diagnostics/page";
import QueuesPage from "./queues/page";
import ResetPasswordPage from "./reset-password/page";
import RequestPage from "./requests/[id]/page";
import ResultPage from "./results/[id]/page";
import ArchivedRequestPage from "./archive/[id]/page";
import SampleLabelPage from "./samples/[id]/label/page";
import { AppShell } from "@/components/app-shell";
import { AdminConsole } from "@/components/admin-console";

const connection = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection }));

describe("Next route composition", () => {
  it("keeps the document metadata boundary, opts into request-time rendering and renders its child", async () => {
    const child = <main>Conteúdo verificado</main>;
    const layout = await RootLayout({ children: child });

    expect(connection).toHaveBeenCalledTimes(1);
    expect(layout.props.lang).toBe("pt-BR");
    expect(layout.props.children.type).toBe("body");
    expect(layout.props.children.props.children).toBe(child);
  });

  it("composes every synchronous application route", () => {
    for (const page of [
      HomePage,
      AccountPage,
      AdminPage,
      IndicatorsPage,
      LoginPage,
      ManagementPage,
      NotificationsPage,
      PatientsPage,
      QueuesPage,
      ResetPasswordPage
    ]) {
      expect(page()).toBeTruthy();
    }
  });

  it("resolves dynamic route params before composing their workspaces", async () => {
    expect(await PatientDiagnosticsPage({ params: Promise.resolve({ id: "patient-1" }) })).toBeTruthy();
    expect(await RequestPage({ params: Promise.resolve({ id: "request-1" }) })).toBeTruthy();
    expect(await ResultPage({ params: Promise.resolve({ id: "result-1" }) })).toBeTruthy();
    expect(await ArchivedRequestPage({ params: Promise.resolve({ id: "request-1" }) })).toBeTruthy();
    expect(await SampleLabelPage({ params: Promise.resolve({ id: "sample-1" }) })).toBeTruthy();
  });

  it("keeps user administration and the examination catalog on distinct sections of the shared shell", async () => {
    const users = (await import("./admin/users/page")).default();
    const catalog = (await import("./admin/catalog/page")).default();
    for (const page of [users, catalog]) {
      expect(page.type).toBe(AppShell);
      expect(page.props.children.type).toBe(AdminConsole);
    }
    expect(users.props.children.props.section).toBe("users");
    expect(catalog.props.children.props.section).toBe("catalog");
  });

  it("exposes the dedicated hospital workspaces behind the application shell and leaves invite acceptance public", async () => {
    const routes = [
      [await import("./admin/access-groups/page"), "AdminAccessGroups"],
      [await import("./admin/departments/page"), "DepartmentConsole"],
      [await import("./admin/hospital-services/page"), "HospitalServiceConsole"],
      [await import("./admin/institution/page"), "HospitalInstitutionConsole"],
      [await import("./admin/integrations/page"), "HospitalIntegrationConsole"],
      [await import("./admin/invitations/page"), "HospitalInvitations"],
      [await import("./admin/resources/page"), "HospitalResourceConsole"],
      [await import("./planner/page"), "PlannerView"],
      [await import("./planner/agenda/page"), "HospitalCalendarView"],
      [await import("./planner/beds/page"), "HospitalBedCensus"],
      [await import("./planner/capacity/page"), "HospitalCapacityView"],
      [await import("./planner/checklists/page"), "PlannerChecklists"],
      [await import("./planner/documents/page"), "HospitalDocumentLibrary"],
      [await import("./planner/following/page"), "WorkActivityLibrary"],
      [await import("./planner/handoffs/page"), "PlannerHandoffs"],
      [await import("./planner/inbox/page"), "WorkInbox"],
      [await import("./planner/intake/page"), "PlannerIntake"],
      [await import("./planner/metrics/page"), "HospitalMetricsView"],
      [await import("./planner/plans/page"), "PlannerPlans"],
      [await import("./planner/recurrences/page"), "PlannerRecurrences"],
      [await import("./planner/reports/page"), "HospitalReportView"],
      [await import("./planner/search/page"), "PlannerSearch"],
      [await import("./planner/shifts/page"), "PlannerShifts"],
      [await import("./planner/timeline/page"), "PlannerTimeline"],
      [await import("./planner/types/page"), "PlannerTaskTypes"]
    ] as const;
    for (const [route, workspace] of routes) {
      const page = route.default();
      expect(page.type).toBe(AppShell);
      expect(page.props.children.type.name).toBe(workspace);
    }
    const invite = (await import("./invite/page")).default();
    expect(invite.type.name).toBe("HospitalInvitationAccept");
  });

  it("passes the resolved hospital entity identity to the matching workspace without substituting another route", async () => {
    const task = await (await import("./planner/tasks/[taskId]/page")).default({ params: Promise.resolve({ taskId: "task-identity" }) });
    const plan = await (await import("./planner/plans/[planId]/page")).default({ params: Promise.resolve({ planId: "plan-identity" }) });
    const shift = await (await import("./planner/shifts/[shiftId]/page")).default({ params: Promise.resolve({ shiftId: "shift-identity" }) });
    const document = await (await import("./planner/documents/[documentId]/page")).default({ params: Promise.resolve({ documentId: "document-identity" }) });
    for (const page of [task, plan, shift, document]) expect(page.type).toBe(AppShell);
    expect(task.props.children.props).toEqual({ taskId: "task-identity" });
    expect(plan.props.children.props).toEqual({ planId: "plan-identity" });
    expect(shift.props.children.props).toEqual({ shiftId: "shift-identity" });
    expect(document.props.children.props).toEqual({ documentId: "document-identity" });
  });
});
