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
});
