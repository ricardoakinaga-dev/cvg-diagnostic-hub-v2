import { expect, test } from "@playwright/test";

async function signInAs(page: import("@playwright/test").Page, email: string, expectedHeading: RegExp): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-mail profissional").fill(email);
  await page.getByLabel("Senha").fill("e2e-local-password-2026");
  await page.getByRole("button", { name: "Entrar no Hub" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15000 });
  await expect(page.getByRole("heading", { name: expectedHeading })).toBeVisible({ timeout: 15000 });
}

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await signInAs(page, "vet@cvg.local", /Bom dia/);
}

async function confirmDuplicateIfNeeded(page: import("@playwright/test").Page): Promise<void> {
  const reason = page.getByLabel("Motivo para prosseguir com a duplicidade");
  try {
    await reason.waitFor({ state: "visible", timeout: 1500 });
  } catch {
    return;
  }
  await reason.fill("Repetição controlada para validar o aviso de duplicidade no ambiente sintético.");
  await page.getByRole("button", { name: /Confirmar duplicidade/ }).click();
}

test.describe("operational hub journeys", () => {
  test("authenticates and renders the attention dashboard", async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole("region", { name: "Indicadores de atenção" })).toBeVisible();
    await expect(page.getByText("Solicitações em andamento")).toBeVisible();
    await expect(page.getByRole("link", { name: /Central de exames/ })).toBeVisible();
  });

  test("renders a useful technical home for an administrator", async ({ page }) => {
    await signInAs(page, "admin@cvg.local", /Administração técnica/);
    await expect(page.getByText("Você não tem acesso a este recurso.")).toHaveCount(0);
    await expect(page.getByRole("navigation").getByRole("link", { name: "Administração" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Central de exames" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Notificações" })).toHaveCount(0);
  });

  test("lets an administrator configure a delegated manager scope", async ({ page }, testInfo) => {
    const suffix = `${Date.now()}-${testInfo.project.name}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const email = `scope-${suffix}@cvg.local`;

    await signInAs(page, "admin@cvg.local", /Administração técnica/);
    await page.goto("/admin#users");
    const userCreate = page.locator("#users details");
    await userCreate.locator("summary").click();
    await userCreate.getByLabel("Nome completo").fill("Gestor de escopo E2E");
    await userCreate.getByLabel("E-mail institucional").fill(email);
    await userCreate.getByLabel("Role").selectOption("MANAGER");
    await userCreate.getByLabel("Setor", { exact: true }).fill("OPERATIONS");
    await userCreate.getByLabel("Setores gerenciados").fill("LABORATORY, RADIOLOGY");
    await userCreate.getByLabel("Senha inicial").fill("e2e-manager-password-123");
    await userCreate.getByLabel("Motivo da criação").fill("Delegação operacional para teste");
    await userCreate.getByLabel("Senha do gestor para confirmar").fill("e2e-local-password-2026");
    await userCreate.getByLabel("Confirmo a criação deste acesso").check();
    await userCreate.getByRole("button", { name: "Criar acesso" }).click();

    const userRow = page.locator("#users .admin-row").filter({ hasText: email });
    await expect(userRow).toBeVisible();
    await expect(userRow.getByLabel("Setores gerenciados")).toHaveValue("LABORATORY, RADIOLOGY");
    await userRow.getByLabel("Setores gerenciados").fill("ULTRASOUND");
    await userRow.getByLabel("Motivo da alteração").fill("Revisão do escopo operacional");
    await userRow.getByLabel("Senha para reautenticar").fill("e2e-local-password-2026");
    await userRow.getByLabel("Confirmo esta alteração de acesso").check();
    await userRow.getByRole("button", { name: `Salvar ${email}` }).click();
    await expect(userRow.getByLabel("Setores gerenciados")).toHaveValue("ULTRASOUND");
  });

  test("gives a manager scoped control, catalog and collaborator workflows", async ({ page }, testInfo) => {
    const suffix = `${Date.now()}-${testInfo.project.name}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const serviceCode = `E2E_${suffix.replaceAll("-", "_")}`.toUpperCase();
    const reasonCode = `E2E_${suffix.replaceAll("-", "_")}`.toUpperCase();
    const email = `e2e-${suffix}@cvg.local`;

    await signInAs(page, "manager@cvg.local", /Controle operacional/);
    const mainNavigation = page.getByRole("navigation", { name: "Navegação principal" });
    await expect(mainNavigation.getByRole("link", { name: "Solicitações" })).toBeVisible();
    await expect(mainNavigation.getByRole("link", { name: "Pendências" })).toBeVisible();
    await expect(mainNavigation.getByRole("link", { name: "Estatísticas" })).toBeVisible();

    await mainNavigation.getByRole("link", { name: "Catálogos" }).click();
    await expect(page).toHaveURL(/\/admin#catalog/);
    await expect(page.getByRole("heading", { name: "Serviços diagnósticos" })).toBeVisible();
    const serviceCreate = page.locator("#catalog details");
    await serviceCreate.locator("summary").click();
    await serviceCreate.getByLabel("Código").fill(serviceCode);
    await serviceCreate.getByLabel("Nome").fill("Painel operacional E2E");
    await serviceCreate.getByLabel("Setor").fill("LABORATORY");
    await serviceCreate.getByLabel("Workflow").selectOption("LABORATORY");
    await serviceCreate.getByLabel("Exige agenda").check();
    await serviceCreate.getByLabel("SLA urgente (h)").fill("6");
    await serviceCreate.getByRole("button", { name: "Criar serviço" }).click();
    const serviceRow = page.locator("#catalog .admin-row").filter({ hasText: serviceCode });
    await expect(serviceRow).toBeVisible();
    await serviceRow.getByLabel("Nome").fill("Painel operacional E2E revisado");
    await serviceRow.getByLabel("SLA emergência (h)").fill("3");
    await serviceRow.getByRole("button", { name: /Salvar/ }).click();
    await expect(serviceRow.getByLabel("Nome")).toHaveValue("Painel operacional E2E revisado");

    await page.goto("/admin#reasons");
    const reasonCreate = page.locator("#reasons details");
    await reasonCreate.locator("summary").click();
    await reasonCreate.getByLabel("Tipo").selectOption("RECOLLECTION");
    await reasonCreate.getByLabel("Código").fill(reasonCode);
    await reasonCreate.getByLabel("Descrição").fill("Motivo operacional E2E");
    await reasonCreate.getByRole("button", { name: "Criar motivo" }).click();
    const reasonRow = page.locator("#reasons .admin-row").filter({ hasText: reasonCode });
    await expect(reasonRow).toBeVisible();
    await reasonRow.getByLabel("Descrição").fill("Motivo operacional E2E revisado");
    await reasonRow.getByRole("button", { name: `Salvar ${reasonCode}` }).click();
    await expect(reasonRow.getByLabel("Descrição")).toHaveValue("Motivo operacional E2E revisado");

    await page.goto("/admin#users");
    const userCreate = page.locator("#users details");
    await userCreate.locator("summary").click();
    await userCreate.getByLabel("Nome completo").fill("Colaborador E2E");
    await userCreate.getByLabel("E-mail institucional").fill(email);
    await userCreate.getByLabel("Role").selectOption("LAB_TECH");
    await userCreate.getByLabel("Setor").fill("LABORATORY");
    await userCreate.getByLabel("Senha inicial").fill("e2e-collaborator-123");
    await userCreate.getByLabel("Motivo da criação").fill("Teste operacional de provisionamento");
    await userCreate.getByLabel("Senha do gestor para confirmar").fill("e2e-local-password-2026");
    await userCreate.getByLabel("Confirmo a criação deste acesso").check();
    await userCreate.getByRole("button", { name: "Criar acesso" }).click();
    const userRow = page.locator("#users .admin-row").filter({ hasText: email });
    await expect(userRow).toBeVisible();
    await userRow.getByLabel("Motivo da alteração").fill("Encerramento do teste operacional");
    await userRow.getByLabel("Senha para reautenticar").fill("e2e-local-password-2026");
    await userRow.getByLabel("Confirmo esta alteração de acesso").check();
    await userRow.getByRole("button", { name: "Desativar acesso" }).click();
    await expect(userRow).toContainText("Desativado", { timeout: 15000 });
  });

  test("creates a contextual multi-service request through the UI", async ({ page }, testInfo) => {
    const scenario = {
      chromium: { patient: "patient-thor", services: ["Hemograma", "RX de tórax"] },
      tablet: { patient: "patient-mel", services: ["Proteína C reativa", "Ultrassom abdominal"] },
      mobile: { patient: "patient-mel", services: ["Hemograma", "RX de tórax"] }
    }[testInfo.project.name] ?? { patient: "patient-thor", services: ["Hemograma", "RX de tórax"] };
    await signIn(page);
    await page.getByRole("button", { name: /Nova solicitação/ }).click();
    await expect(page.getByRole("dialog", { name: "Solicitar exames" })).toBeVisible();
    await page.getByLabel("Paciente").selectOption(scenario.patient);
    await page.getByLabel("Atendimento").selectOption(scenario.patient === "patient-thor" ? "encounter-thor" : "encounter-mel");
    for (const service of scenario.services) await page.getByText(service, { exact: true }).click();
    await page.getByRole("button", { name: /Confirmar solicitação/ }).click();
    await confirmDuplicateIfNeeded(page);
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByText("EX-", { exact: false }).first()).toBeVisible();
  });

  test("keeps request actions inside the items panel", async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width: 1260, height: 720 });
    await page.route("**/api/v1/diagnostic-requests/request-layout", async (route) => {
      await route.fulfill({
        json: {
          data: {
            id: "request-layout",
            requestCode: "EX-LAYOUT-0001",
            priority: "URGENT",
            aggregateStatus: "REQUESTED",
            createdAt: "2026-08-20T12:00:00.000Z",
            patient: { displayName: "Thor", species: "Canino", sex: "Macho", externalId: "HIS-THOR-001", ownerLabel: "A. Oliveira" },
            items: [
              { id: "item-layout-lab", status: "REQUESTED", workflowType: "LABORATORY", priority: "URGENT", dueAt: "2026-08-20T13:00:00.000Z", version: 1, service: { name: "Hemograma", workflowType: "LABORATORY" } },
              { id: "item-layout-us", status: "REQUESTED", workflowType: "ULTRASOUND", priority: "URGENT", dueAt: "2026-08-20T13:00:00.000Z", version: 1, service: { name: "Ultrassom abdominal", workflowType: "ULTRASOUND" } }
            ]
          },
          meta: { correlationId: "e2e-layout", requestId: "e2e-layout" }
        }
      });
    });
    await page.route("**/api/v1/timeline**", async (route) => {
      await route.fulfill({ json: { data: [{ id: "event-layout", eventType: "Diagnostic Request Created", newState: "REQUESTED", occurredAt: "2026-08-20T12:00:00.000Z" }], meta: { correlationId: "e2e-layout", requestId: "e2e-layout" } } });
    });

    await page.goto("/requests/request-layout");
    await expect(page.getByRole("heading", { name: /Thor em acompanhamento/ })).toBeVisible();
    const itemsPanel = await page.locator(".detail-items").boundingBox();
    const timelinePanel = await page.locator(".timeline-panel").boundingBox();
    const action = await page.getByRole("button", { name: "Receber amostra" }).boundingBox();
    if (!itemsPanel || !timelinePanel || !action) throw new Error("Não foi possível medir os painéis da solicitação.");
    expect(action.x + action.width).toBeLessThanOrEqual(itemsPanel.x + itemsPanel.width + 1);
    expect(action.x + action.width).toBeLessThanOrEqual(timelinePanel.x - 8);
  });

  test("keeps navigation usable on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await expect(page.getByRole("heading", { name: /Bom dia/ })).toBeVisible();
    await page.getByRole("link", { name: /Abrir notificações/ }).click();
    await expect(page).toHaveURL(/notifications/, { timeout: 15000 });
    await expect(page.getByRole("heading", { name: /Notificações/ })).toBeVisible();
  });

  test("opens the patient context without exposing an unscoped list", async ({ page }) => {
    await signIn(page);
    await page.getByRole("link", { name: /Meus pacientes/ }).click();
    await expect(page).toHaveURL(/\/patients$/);
    await expect(page.getByRole("heading", { name: /Meus pacientes/ })).toBeVisible();
    await page.goto("/patients/patient-thor/diagnostics");
    await expect(page).toHaveURL(/\/patients\/patient-thor\/diagnostics$/);
    await expect(page.getByRole("heading", { name: /Thor/ })).toBeVisible();
  });

  test("keeps the dashboard useful when one resource is unavailable", async ({ page }) => {
    await page.route("**/api/v1/notifications**", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("filter") === "UNREAD") await route.abort("failed");
      else await route.continue();
    });
    await signIn(page);
    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível atualizar as notificações." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Solicitações em andamento" })).toBeVisible();
  });
});
