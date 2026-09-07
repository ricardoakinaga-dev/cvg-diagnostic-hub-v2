import { describe, expect, it } from "vitest";
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
import RequestPage from "./requests/[id]/page";
import ResultPage from "./results/[id]/page";

describe("Next route composition", () => {
  it("keeps the document metadata boundary and renders its child", () => {
    const child = <main>Conteúdo verificado</main>;
    const layout = RootLayout({ children: child });

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
      QueuesPage
    ]) {
      expect(page()).toBeTruthy();
    }
  });

  it("resolves dynamic route params before composing their workspaces", async () => {
    expect(await PatientDiagnosticsPage({ params: Promise.resolve({ id: "patient-1" }) })).toBeTruthy();
    expect(await RequestPage({ params: Promise.resolve({ id: "request-1" }) })).toBeTruthy();
    expect(await ResultPage({ params: Promise.resolve({ id: "result-1" }) })).toBeTruthy();
  });
});
