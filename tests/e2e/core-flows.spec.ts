import { expect, test } from "@playwright/test";
import { GREETING, signInAs, signOut } from "./support/auth";
import { seedHemogramRequest } from "./support/seed";

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await signInAs(page, "vet@cvg.local", GREETING);
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

function responsiveNavLink(
  page: import("@playwright/test").Page,
  projectName: string,
  desktopLabel: string,
  mobileLabel: string
) {
  const compact = projectName !== "chromium";
  const navigation = page.getByRole("navigation", { name: compact ? "Navegação rápida" : "Navegação principal" });
  return navigation.getByRole("link", { name: compact ? `Acesso rápido: ${mobileLabel}` : desktopLabel, exact: true });
}

test.describe("operational hub journeys", () => {
  test("authenticates and renders the Plane-style home", async ({ page, browser }, testInfo) => {
    // AUD-09: the Setores widget only renders with requests in scope; the scenario brings its own instead of
    // relying on what clinical-lifecycle or other specs left behind.
    await seedHemogramRequest(browser, testInfo, "home-seed");
    await signIn(page);
    const shortcuts = page.getByRole("navigation", { name: "Atalhos" });
    await expect(shortcuts.getByRole("link", { name: /Atrasados/ })).toHaveAttribute("href", "/queues?preset=overdue");
    await expect(page.getByRole("heading", { name: "Precisa de atenção" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Setores" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Solicitações recentes" })).toBeVisible();
    await expect(responsiveNavLink(page, testInfo.project.name, "Todos os exames", "Exames")).toBeVisible();
  });

  test("opens the server-derived operational context without leaving the exam queue", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /Nova solicitação/ }).or(page.getByRole("link", { name: /Nova solicitação/ })).click();
    await page.getByRole("dialog", { name: "Solicitar exames" }).getByRole("combobox", { name: "Paciente", exact: true }).selectOption("patient-thor");
    await page.getByRole("dialog", { name: "Solicitar exames" }).getByLabel("Atendimento").selectOption("encounter-thor");
    await page.getByRole("dialog", { name: "Solicitar exames" }).getByText("Hemograma", { exact: true }).click();
    await page.getByRole("button", { name: /Confirmar solicitação/ }).click();
    await confirmDuplicateIfNeeded(page);
    await signOut(page);
    await expect(page).toHaveURL(/\/login/);

    await signInAs(page, "lab@cvg.local", GREETING);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/queues");
    await expect(page.getByRole("heading", { name: "Todos os exames" })).toBeVisible();
    const opener = page.getByRole("button", { name: /^Abrir Hemograma — / }).first();
    await opener.click();
    const peek = page.getByRole("dialog", { name: "Hemograma" });
    await expect(peek).toBeVisible();
    await expect(peek.getByRole("heading", { name: "Hemograma" })).toBeFocused();
    await expect(peek.getByText("Responsável", { exact: true })).toBeVisible();
    await expect(peek.getByText("Próxima ação", { exact: true })).toBeVisible();
    await expect(peek.getByText("Escalonamento", { exact: true })).toBeVisible();
    await expect(peek.getByRole("link", { name: /Abrir workspace completo/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(peek).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("renders a useful technical home for an administrator", async ({ page }, testInfo) => {
    await signInAs(page, "admin@cvg.local", /Administração técnica/);
    await expect(page.getByText("Você não tem acesso a este recurso.")).toHaveCount(0);
    await expect(responsiveNavLink(page, testInfo.project.name, "Administração", "Admin")).toBeVisible();
    await expect(page.getByRole("link", { name: "Todos os exames" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Caixa de entrada" })).toHaveCount(0);
  });

  test("lets an administrator configure a delegated manager scope", async ({ page }, testInfo) => {
    const email = `scope-${Date.now()}-${testInfo.project.name}@cvg.local`;
    await signInAs(page, "admin@cvg.local", /Administração técnica/);
    await page.goto("/admin#users");
    const create = page.getByRole("form", { name: "Adicionar colaborador" });
    await create.getByLabel("Nome completo").fill("Gestor de escopo E2E");
    await create.getByLabel("E-mail institucional").fill(email);
    await create.getByLabel("Perfil").selectOption("MANAGER");
    await create.getByText("Opções avançadas", { exact: true }).click();
    await create.getByLabel("Setores gerenciados").fill("LABORATORY, RADIOLOGY");
    await create.getByRole("button", { name: "Criar acesso" }).click();
    await page.getByRole("dialog", { name: "Senha inicial", exact: true }).getByRole("button", { name: "Fechar", exact: true }).click();
    const row = page.getByRole("form", { name: `Acesso de ${email}`, exact: true });
    await expect(row).toBeVisible();
    await row.getByText("Opções avançadas", { exact: true }).click();
    await expect(row.getByLabel("Setores gerenciados")).toHaveValue("LABORATORY, RADIOLOGY");
    await row.getByLabel("Setores gerenciados").fill("ULTRASOUND");
    await row.getByRole("button", { name: `Salvar ${email}`, exact: true }).click();
    await expect(row.getByLabel("Setores gerenciados")).toHaveValue("ULTRASOUND");
  });

  test("gives a manager scoped control, catalog and collaborator workflows", async ({ page }, testInfo) => {
    const suffix = `${Date.now()}-${testInfo.project.name}`;
    const name = `Painel operacional E2E ${suffix}`;
    const reasonLabel = `Motivo operacional E2E ${suffix}`;
    const email = `e2e-${suffix}@cvg.local`;
    await signInAs(page, "manager@cvg.local", GREETING);
    if (testInfo.project.name === "chromium") {
      const nav = page.getByRole("navigation", { name: "Navegação principal" });
      await expect(nav.getByRole("link", { name: "Solicitações", exact: true })).toBeVisible();
      await expect(nav.getByRole("link", { name: "Pendências", exact: true })).toBeVisible();
      await expect(nav.getByRole("link", { name: "Estatísticas", exact: true })).toBeVisible();
      await nav.getByRole("link", { name: "Catálogos", exact: true }).click();
    } else await page.goto("/admin#catalog");
    await expect(page.getByRole("heading", { name: "Serviços diagnósticos" })).toBeVisible();
    const createService = page.getByRole("form", { name: "Adicionar serviço", exact: true });
    await createService.getByLabel("Nome", { exact: true }).fill(name);
    await createService.getByRole("button", { name: "Criar serviço", exact: true }).click();
    const serviceRow = page.getByRole("form", { name: `Serviço ${name}`, exact: true });
    await expect(serviceRow).toBeVisible();
    await serviceRow.getByText("Opções avançadas do exame", { exact: true }).click();
    await serviceRow.getByLabel("SLA emergência (h)").fill("3");
    await serviceRow.getByRole("button", { name: `Salvar ${name}`, exact: true }).click();
    await expect(serviceRow.getByLabel("SLA emergência (h)")).toHaveValue("3");
    await page.goto("/admin#reasons");
    const createReason = page.locator("#reasons details").first();
    await createReason.locator("summary").click();
    await createReason.getByLabel("Tipo").selectOption("RECOLLECTION");
    await createReason.getByLabel("Descrição").fill(reasonLabel);
    await createReason.getByRole("button", { name: "Criar motivo" }).click();
    const reasonRow = page.getByRole("form", { name: `Motivo ${reasonLabel}`, exact: true });
    await expect(reasonRow).toBeVisible();
    await reasonRow.getByLabel("Descrição").fill(`${reasonLabel} revisado`);
    await reasonRow.getByRole("button", { name: /Salvar/ }).click();
    await expect(page.getByRole("form", { name: `Motivo ${reasonLabel} revisado`, exact: true })).toBeVisible();
    await page.goto("/admin#users");
    const userCreate = page.getByRole("form", { name: "Adicionar colaborador" });
    await userCreate.getByLabel("Nome completo").fill("Colaborador E2E");
    await userCreate.getByLabel("E-mail institucional").fill(email);
    await userCreate.getByLabel("Perfil").selectOption("LAB_TECH");
    await userCreate.getByRole("button", { name: "Criar acesso" }).click();
    await page.getByRole("dialog", { name: "Senha inicial", exact: true }).getByRole("button", { name: "Fechar", exact: true }).click();
    const userRow = page.getByRole("form", { name: `Acesso de ${email}`, exact: true });
    await userRow.getByRole("button", { name: "Desativar acesso" }).click();
    await expect(userRow).toContainText("Desativado");
    await userRow.getByRole("button", { name: "Desfazer" }).click();
    await expect(userRow.getByText("Ativo", { exact: true })).toBeVisible();
  });

  test("creates a contextual multi-service request through the UI", async ({ page }, testInfo) => {
    const scenario = {
      chromium: { patient: "patient-thor", services: ["Hemograma", "RX de tórax"] },
      tablet: { patient: "patient-mel", services: ["Proteína C reativa", "Ultrassom abdominal"] },
      mobile: { patient: "patient-mel", services: ["Hemograma", "RX de tórax"] }
    }[testInfo.project.name] ?? { patient: "patient-thor", services: ["Hemograma", "RX de tórax"] };
    await signIn(page);
    await page.getByRole("button", { name: /Nova solicitação/ }).or(page.getByRole("link", { name: /Nova solicitação/ })).click();
    const requestDialog = page.getByRole("dialog", { name: "Solicitar exames" });
    await expect(requestDialog).toBeVisible();
    await requestDialog.getByRole("combobox", { name: "Paciente", exact: true }).selectOption(scenario.patient);
    await requestDialog.getByLabel("Atendimento").selectOption(scenario.patient === "patient-thor" ? "encounter-thor" : "encounter-mel");
    for (const service of scenario.services) await requestDialog.getByText(service, { exact: true }).click();
    await requestDialog.getByRole("button", { name: /Confirmar solicitação/ }).click();
    await confirmDuplicateIfNeeded(page);
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByText("Solicitação criada", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Todos os exames" })).toBeVisible();
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
    const workflowTargets = page.locator(".workflow-action > .button, .workflow-action-link, .workflow-secondary-action");
    const workflowTargetCount = await workflowTargets.count();
    expect(workflowTargetCount).toBeGreaterThan(0);
    for (let index = 0; index < workflowTargetCount; index += 1) {
      const box = await workflowTargets.nth(index).boundingBox();
      if (!box) throw new Error(`Não foi possível medir o alvo de workflow ${index}.`);
      expect(box.height, `alvo de workflow ${index} abaixo de 44px`).toBeGreaterThanOrEqual(44);
    }
  });

  test("keeps navigation usable on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/v1/realtime/events", async (route) => { await route.abort("failed"); });
    await signIn(page);
    await expect(page.getByRole("heading", { name: GREETING })).toBeVisible();
    const realtimeRefresh = page.locator(".realtime-banner .button");
    await expect(realtimeRefresh).toBeVisible();
    const realtimeBox = await realtimeRefresh.boundingBox();
    if (!realtimeBox) throw new Error("Não foi possível medir a ação realtime móvel.");
    expect(realtimeBox.height, "ação realtime abaixo de 44px").toBeGreaterThanOrEqual(44);
    await page.getByRole("link", { name: /Abrir notificações/ }).click();
    await expect(page).toHaveURL(/notifications/, { timeout: 15000 });
    await expect(page.getByRole("heading", { name: "Caixa de entrada" })).toBeVisible();
  });

  test("opens the patient context without exposing an unscoped list", async ({ page }, testInfo) => {
    await signIn(page);
    await responsiveNavLink(page, testInfo.project.name, "Pacientes", "Pacientes").click();
    await expect(page).toHaveURL(/\/patients$/);
    await expect(page.getByRole("heading", { name: "Pacientes" })).toBeVisible();
    await page.goto("/patients/patient-thor/diagnostics");
    await expect(page).toHaveURL(/\/patients\/patient-thor\/diagnostics$/);
    await expect(page.getByRole("heading", { name: /Thor/ })).toBeVisible();
  });

  test("renders the Patient Workspace as a responsive, server-derived snapshot", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const viewport = {
      chromium: { width: 1440, height: 1000 },
      tablet: { width: 834, height: 1194 },
      mobile: { width: 375, height: 812 }
    }[testInfo.project.name] ?? { width: 1440, height: 1000 };
    const consoleErrors: string[] = [];
    type FixtureMode = "ready" | "loading" | "error" | "empty" | "partial" | "stale";
    type DiagnosticsFixture = {
      data?: {
        events?: Array<{ id: string; eventType: string; occurredAt: string; newState?: string }>;
        items?: Array<{ items?: Array<{
          status?: string;
          workspaceContext?: { result?: unknown; attachments?: unknown[]; sample?: unknown };
        }> }>;
        nextActions?: unknown[];
        nextCursor?: string;
        total?: number;
        workspace?: { summary?: Record<string, unknown>; asOf?: string; dataQuality?: { status?: string; asOf?: string; note?: string } };
      };
    };
    let fixtureMode: FixtureMode = "ready";
    let releaseLoading: (() => void) | undefined;
    await signIn(page);
    let baselineResponse = await page.evaluate(async () => {
      const response = await fetch("/api/v1/patients/patient-thor/diagnostics?limit=50");
      return { status: response.status, body: await response.text() };
    });
    if (baselineResponse.status < 200 || baselineResponse.status >= 300) {
      throw new Error(`A resposta base de diagnósticos falhou com HTTP ${baselineResponse.status}.`);
    }
    let baselineBody = JSON.parse(baselineResponse.body) as DiagnosticsFixture;
    if ((baselineBody.data?.items?.length ?? 0) === 0) {
      await page.getByRole("button", { name: /Nova solicitação/ }).or(page.getByRole("link", { name: /Nova solicitação/ })).click();
      const requestDialog = page.getByRole("dialog", { name: "Solicitar exames" });
      await requestDialog.getByRole("combobox", { name: "Paciente", exact: true }).selectOption("patient-thor");
      await requestDialog.getByLabel("Atendimento").selectOption("encounter-thor");
      await requestDialog.getByText("Hemograma", { exact: true }).click();
      await requestDialog.getByRole("button", { name: /Confirmar solicitação/ }).click();
      await confirmDuplicateIfNeeded(page);
      baselineResponse = await page.evaluate(async () => {
        const response = await fetch("/api/v1/patients/patient-thor/diagnostics?limit=50");
        return { status: response.status, body: await response.text() };
      });
      if (baselineResponse.status < 200 || baselineResponse.status >= 300) {
        throw new Error(`A resposta de diagnósticos após a criação falhou com HTTP ${baselineResponse.status}.`);
      }
      baselineBody = JSON.parse(baselineResponse.body) as DiagnosticsFixture;
    }
    page.on("response", (response) => { if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.url()}`); });
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(`${message.text()} @ ${message.location().url}`); });
    await page.setViewportSize(viewport);
    await page.route("**/api/v1/patients/patient-thor/diagnostics*", async (route) => {
      if (fixtureMode === "loading") {
        await new Promise<void>((resolve) => { releaseLoading = resolve; });
        await route.continue();
        return;
      }
      if (fixtureMode === "error") {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Paciente indisponível" } })
        });
        return;
      }
      if (fixtureMode === "stale") {
        await route.abort("failed");
        return;
      }

      const body = JSON.parse(JSON.stringify(baselineBody)) as DiagnosticsFixture;
      if (!body.data) throw new Error("A resposta de diagnósticos não trouxe data para o fixture visual.");
      if (fixtureMode === "empty") {
        body.data.items = [];
        body.data.nextActions = [];
        body.data.events = [];
        body.data.nextCursor = undefined;
        body.data.total = 0;
        if (body.data.workspace?.summary) {
          Object.assign(body.data.workspace.summary, { requestCount: 0, itemCount: 0, activeItemCount: 0, availableResultCount: 0, sampleCount: 0, attachmentCount: 0 });
        }
      } else if (fixtureMode === "partial") {
        const firstItem = body.data.items?.[0]?.items?.[0];
        if (firstItem?.workspaceContext) {
          firstItem.workspaceContext.result = null;
          firstItem.workspaceContext.attachments = [];
          firstItem.workspaceContext.sample = null;
        }
        if (body.data.workspace) {
          body.data.workspace.dataQuality = {
            status: "DEGRADED",
            asOf: body.data.workspace.asOf,
            note: "A leitura auxiliar de amostras, resultados e anexos está indisponível; os itens autorizados continuam visíveis."
          };
        }
        body.data.events = (body.data.events ?? []).slice(-1).map((event) => ({ ...event, newState: "REQUESTED" }));
        if (body.data.workspace?.summary) Object.assign(body.data.workspace.summary, { availableResultCount: 0, sampleCount: 0, attachmentCount: 0 });
      } else if (testInfo.project.name === "mobile") {
        const baseTime = Date.parse("2026-09-06T12:00:00.000Z");
        body.data.events = Array.from({ length: 12 }, (_, index) => ({
          id: `visual-dense-event-${index}`,
          eventType: index % 3 === 0 ? "ResultRead" : "DiagnosticItemRequested",
          occurredAt: new Date(baseTime + index * 60_000).toISOString(),
          newState: index % 2 === 0 ? "RESULT_AVAILABLE" : "REQUESTED"
        }));
      }
      await route.fulfill({ status: baselineResponse.status, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/patients/patient-thor/diagnostics", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("patient-workspace")).toBeVisible();
    const compact = testInfo.project.name !== "chromium";
    const navigation = page.getByRole("navigation", { name: compact ? "Navegação rápida" : "Navegação principal" });
    const assertShell = async () => {
      await expect(navigation).toBeVisible();
      if (compact) {
        await expect(page.getByRole("navigation", { name: "Navegação principal" })).toBeHidden();
        await expect(page.locator(".sidebar")).toBeHidden();
        await expect(page.locator(".mobile-nav")).toBeVisible();
      } else {
        await expect(page.locator(".sidebar")).toBeVisible();
      }
      await expect(page.locator(".app-topbar")).toBeVisible();
      const shellGeometry = await page.evaluate(() => ({
        sidebar: document.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect().toJSON(),
        topbar: document.querySelector<HTMLElement>(".app-topbar")?.getBoundingClientRect().toJSON(),
        mobileNav: document.querySelector<HTMLElement>(".mobile-nav")?.getBoundingClientRect().toJSON()
      }));
      if (compact) {
        expect(shellGeometry.mobileNav?.width, "navegação inferior sem largura visível").toBeGreaterThan(0);
        expect(shellGeometry.mobileNav?.height, "navegação inferior sem altura visível").toBeGreaterThan(0);
      } else {
        expect(shellGeometry.sidebar?.width, "rail lateral sem geometria visível").toBeGreaterThan(0);
        expect(shellGeometry.sidebar?.height, "rail lateral sem altura visível").toBeGreaterThan(0);
      }
      expect(shellGeometry.topbar?.width, "barra superior sem geometria visível").toBeGreaterThan(0);
      expect(shellGeometry.topbar?.height, "barra superior sem altura visível").toBeGreaterThan(0);
      const navigationHeights = await navigation.locator("a").evaluateAll((links) => links.map((link) => link.getBoundingClientRect().height));
      expect(navigationHeights.length, "navegação sem links visíveis").toBeGreaterThan(0);
      // Touch layouts keep the 44px floor; the desktop sidebar uses Plane density
      // with a mouse and stays above the 24px WCAG 2.5.8 minimum.
      expect(Math.min(...navigationHeights), "alvo essencial de navegação abaixo do piso").toBeGreaterThanOrEqual(compact ? 44 : 28);
      await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
      await expect(page.locator(".user-copy small")).not.toContainText("VETERINARIAN");
    };
    await assertShell();
    const shellLinks = [
      ["Todos os exames", "Exames"],
      ["Pacientes", "Pacientes"],
      ["Caixa de entrada", "Entrada"]
    ] as const;
    for (const [desktopLabel, mobileLabel] of shellLinks) {
      const link = responsiveNavLink(page, testInfo.project.name, desktopLabel, mobileLabel);
      await expect(link).toHaveAttribute("aria-label", compact ? `Acesso rápido: ${mobileLabel}` : desktopLabel);
      if (compact) {
        await expect(link.locator("span")).toHaveText(mobileLabel);
        await expect(link.locator("span")).toBeVisible();
      } else {
        await expect(link).toHaveAttribute("title", desktopLabel);
        await expect(link.locator(".nav-label")).toHaveText(desktopLabel);
        await expect(link.locator(".nav-label")).toBeVisible();
      }
    }
    const patientsLink = responsiveNavLink(page, testInfo.project.name, "Pacientes", "Pacientes");
    await expect(patientsLink).toHaveAttribute("aria-current", "page");
    await patientsLink.focus();
    await expect(patientsLink).toBeFocused();
    await expect.poll(async () => patientsLink.evaluate((element) => {
      const style = getComputedStyle(element);
      return `${style.outlineWidth} ${style.outlineStyle}`;
    })).toBe("3px solid");
    if (compact) {
      const navBox = await patientsLink.boundingBox();
      const labelBox = await patientsLink.locator("span").boundingBox();
      if (!navBox || !labelBox) throw new Error("Não foi possível medir o rótulo ativo da navegação móvel.");
      expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(navBox.x + navBox.width + 1);
      expect(labelBox.y + labelBox.height).toBeLessThanOrEqual(navBox.y + navBox.height + 1);
      expect(await page.locator(".mobile-nav").evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
      const touchTargets = page.locator(".workspace-action-list a, .patient-request-heading > a, .workspace-item-links a");
      const touchTargetCount = await touchTargets.count();
      expect(touchTargetCount).toBeGreaterThan(0);
      for (let index = 0; index < touchTargetCount; index += 1) {
        const box = await touchTargets.nth(index).boundingBox();
        if (!box) throw new Error(`Não foi possível medir o alvo interativo móvel ${index}.`);
        expect(box.height, `alvo interativo móvel ${index} abaixo de 44px`).toBeGreaterThanOrEqual(44);
      }
      const focusTarget = touchTargets.last();
      await focusTarget.scrollIntoViewIfNeeded();
      await focusTarget.focus();
      await expect(focusTarget).toBeFocused();
      const focusGeometry = await page.evaluate(() => {
        const focused = document.activeElement?.getBoundingClientRect();
        const nav = document.querySelector<HTMLElement>(".mobile-nav")?.getBoundingClientRect();
        const topbar = document.querySelector<HTMLElement>(".topbar")?.getBoundingClientRect();
        return { focusTop: focused?.top ?? 0, focusBottom: focused?.bottom ?? 0, navTop: nav?.top ?? window.innerHeight, topbarBottom: topbar?.bottom ?? 0 };
      });
      expect(focusGeometry.focusTop, "foco móvel ficou acima da barra superior").toBeGreaterThanOrEqual(focusGeometry.topbarBottom - 1);
      expect(focusGeometry.focusBottom, "conteúdo focado ficou sob o dock móvel").toBeLessThanOrEqual(focusGeometry.navTop - 1);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const fixedMobileNavBox = await page.locator(".mobile-nav").boundingBox();
      if (!fixedMobileNavBox) throw new Error("Não foi possível medir a navegação inferior após a rolagem.");
      expect(fixedMobileNavBox.y + fixedMobileNavBox.height).toBeGreaterThanOrEqual((await page.evaluate(() => window.innerHeight)) - 1);
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    const workspace = page.getByTestId("patient-workspace");
    await expect(workspace).toBeVisible();
    await expect(page.getByRole("heading", { name: /Thor em acompanhamento/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "Contexto atual do paciente" })).toBeVisible();
    await expect(page.getByText("Contexto atual")).toBeVisible();
    if (compact) {
      await page.evaluate(() => window.scrollTo(0, 0));
      const mobileGeometry = await page.evaluate(() => {
        const context = document.querySelector<HTMLElement>(".workspace-context-card");
        const nav = document.querySelector<HTMLElement>(".mobile-nav");
        const refreshButton = document.querySelector<HTMLElement>(".realtime-banner .button");
        return {
          contextBottom: context?.getBoundingClientRect().bottom ?? 0,
          navTop: nav?.getBoundingClientRect().top ?? window.innerHeight,
          refreshButtonHeight: refreshButton?.getBoundingClientRect().height ?? 44
        };
      });
      expect(mobileGeometry.contextBottom, "conteúdo clínico coberto pelo dock móvel").toBeLessThanOrEqual(mobileGeometry.navTop + 1);
      expect(mobileGeometry.refreshButtonHeight, "ação de atualização abaixo do alvo touch AAA3").toBeGreaterThanOrEqual(44);
    }
    const dimensions = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(dimensions.scrollWidth, `overflow horizontal em ${testInfo.project.name}`).toBeLessThanOrEqual(dimensions.clientWidth + 1);
    expect(consoleErrors, `erros de console em ${testInfo.project.name}`).toEqual([]);
    if (testInfo.project.name === "mobile") {
      const timeline = page.locator("#patient-timeline-events");
      const expandTimeline = page.getByRole("button", { name: "Mostrar mais eventos" });
      await expect(expandTimeline).toBeVisible();
      await expect(expandTimeline).toHaveAttribute("aria-expanded", "false");
      await expect(timeline.locator("li")).toHaveCount(8);
      await page.screenshot({ path: "/tmp/cvg-patient-workspace-mobile-dense-collapsed.png", fullPage: true });
      await expandTimeline.click();
      await expect(page.getByRole("button", { name: "Mostrar menos eventos" })).toHaveAttribute("aria-expanded", "true");
      await expect(timeline.locator("li")).toHaveCount(12);
      await page.screenshot({ path: "/tmp/cvg-patient-workspace-mobile-dense-expanded.png", fullPage: true });
    }
    await page.screenshot({ path: `/tmp/cvg-patient-workspace-${testInfo.project.name}.png`, fullPage: true });

    const captureState = async (state: string) => {
      await assertShell();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `/tmp/cvg-patient-workspace-${testInfo.project.name}-${state}.png`, fullPage: state !== "error-denied" || testInfo.project.name !== "chromium" });
    };

    fixtureMode = "loading";
    releaseLoading = undefined;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("status", { name: "Carregando workspace do paciente" })).toBeVisible();
    await assertShell();
    await expect(page.getByRole("img", { name: "Conexão em tempo real ativa" })).toBeVisible();
    await captureState("loading");
    fixtureMode = "ready";
    const resolveLoading = releaseLoading as (() => void) | undefined;
    resolveLoading?.();
    await expect(page.getByTestId("patient-workspace")).toHaveAttribute("data-workspace-state", "ready");

    fixtureMode = "error";
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".patient-workspace-error")).toContainText("Paciente indisponível");
    await assertShell();
    await captureState("error-denied");
    fixtureMode = "ready";
    await page.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(page.getByTestId("patient-workspace")).toHaveAttribute("data-workspace-state", "ready");

    fixtureMode = "empty";
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Nenhum exame neste contexto")).toBeVisible();
    await expect(page.getByText("Nenhuma ação pendente no escopo visível.")).toBeVisible();
    await expect(page.getByText("Nenhum evento disponível para o contexto autorizado.")).toBeVisible();
    await captureState("empty");

    fixtureMode = "partial";
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Resultado indisponível nesta leitura", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Amostra indisponível nesta leitura", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Anexos indisponíveis nesta leitura", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Indisponível nesta leitura", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Leitura parcial.").first()).toBeVisible();
    await expect(page.getByText("Solicitado", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/amostras, resultados e anexos/)).toBeVisible();
    await expect(page.getByText("Solicitado").first()).toBeVisible();
    await captureState("partial");

    fixtureMode = "ready";
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("patient-workspace")).toHaveAttribute("data-workspace-state", "ready");
    fixtureMode = "stale";
    await page.getByTestId("patient-workspace").getByRole("button", { name: "Atualizar" }).click();
    await expect(page.getByTestId("patient-workspace")).toHaveAttribute("data-workspace-state", "stale");
    await expect(page.getByText(/Snapshot anterior preservado/).first()).toBeVisible();
    await captureState("stale");
    fixtureMode = "ready";
    await page.getByRole("button", { name: "Reconciliar visão" }).click();
    await expect(page.getByTestId("patient-workspace")).toHaveAttribute("data-workspace-state", "ready");
  });

  test("preserves the confirmed Patient Workspace snapshot when refresh is unavailable", async ({ page }) => {
    let diagnosticReads = 0;
    await page.route("**/api/v1/patients/patient-thor/diagnostics*", async (route) => {
      diagnosticReads += 1;
      if (diagnosticReads === 2) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await signIn(page);
    await page.goto("/patients/patient-thor/diagnostics", { waitUntil: "domcontentloaded" });
    const workspace = page.getByTestId("patient-workspace");
    await expect(workspace).toHaveAttribute("data-workspace-state", "ready");
    await page.getByRole("button", { name: "Atualizar" }).click();
    await expect(workspace).toHaveAttribute("data-workspace-state", "stale");
    await expect(page.getByText(/Snapshot anterior preservado/).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /Thor em acompanhamento/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reconciliar visão" })).toBeVisible();
    expect(diagnosticReads).toBe(2);
  });

  test("keeps the dashboard useful when one resource is unavailable", async ({ page }) => {
    await page.route("**/api/v1/notifications**", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("filter") === "UNREAD") await route.abort("failed");
      else await route.continue();
    });
    await signIn(page);
    // The unread badge is optional: the home keeps its exams and shortcuts without it.
    await expect(page.getByRole("heading", { name: "Precisa de atenção" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Atalhos" })).toBeVisible();
    await expect(page.locator(".topbar-badge")).toHaveCount(0);
  });
});
