import { expect, test, type Page } from "@playwright/test";
import { GREETING, signInAs, signOut } from "./support/auth";

async function openPlannerFromMenu(page: Page) {
  const planner = page.getByRole("navigation", { name: "Navegação principal", exact: true }).getByRole("link", { name: "Planner hospitalar", exact: true });
  if (!await planner.isVisible()) await page.getByRole("button", { name: "Abrir menu", exact: true }).click();
  await planner.click();
  await expect(page).toHaveURL(/\/planner$/);
  await expect(page.getByRole("heading", { name: "Planner hospitalar", exact: true })).toBeVisible();
}

test("a normal clinician can locate filtered new work, converse, persist a favorite and complete it", async ({ page }, testInfo) => {
  const title = `Rotina hospitalar E2E ${testInfo.project.name}-${Date.now()}`;
  await signInAs(page, "vet@cvg.local", GREETING);
  await openPlannerFromMenu(page);
  const filtered = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/v1/hospital-tasks" && url.searchParams.get("query") === "filtro-sem-correspondencia-e2e";
  });
  await page.getByLabel("Buscar atividade", { exact: true }).fill("filtro-sem-correspondencia-e2e");
  expect((await filtered).ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "Nenhuma atividade nesta visão" })).toBeVisible();
  await page.getByRole("button", { name: "Nova atividade", exact: true }).click();
  const create = page.getByRole("form", { name: "Criar atividade hospitalar" });
  await create.getByLabel("Título da atividade", { exact: true }).fill(title);
  await create.getByRole("combobox", { name: "Tipo de atividade", exact: true }).selectOption("hospital-task-type-routine");
  await create.getByRole("combobox", { name: "Setor da atividade", exact: true }).selectOption("INPATIENT");
  await create.getByRole("button", { name: "Criar atividade", exact: true }).click();
  await expect(page.getByText("Os filtros atuais ocultam esta atividade.", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: `Abrir ${title}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  const detailUrl = page.url();
  const comment = page.getByRole("form", { name: "Adicionar comentário", exact: true });
  await comment.getByLabel("Texto do comentário", { exact: true }).fill("Conferência sintética da equipe antes da execução.");
  await comment.getByRole("button", { name: "Publicar comentário", exact: true }).click();
  await expect(page.getByText("Conferência sintética da equipe antes da execução.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Adicionar aos favoritos", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remover dos favoritos", exact: true })).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Remover dos favoritos", exact: true })).toBeVisible();
  await expect(page.getByText("Conferência sintética da equipe antes da execução.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Assumir atividade", exact: true }).click();
  await expect(page.getByRole("button", { name: "Assumir atividade", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Iniciar atividade", exact: true }).click();
  await page.getByRole("form", { name: "Confirmar comando da atividade", exact: true }).getByRole("button", { name: "Confirmar início", exact: true }).click();
  await expect(page.getByRole("button", { name: "Concluir atividade", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Concluir atividade", exact: true }).click();
  const finish = page.getByRole("form", { name: "Confirmar comando da atividade", exact: true });
  await finish.getByLabel("Nota de execução (opcional)", { exact: true }).fill("Rotina sintética concluída com conferência.");
  await finish.getByRole("button", { name: "Confirmar conclusão", exact: true }).click();
  await expect(page.getByText("Nota de conclusão: Rotina sintética concluída com conferência.", { exact: true })).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(detailUrl);
  await expect(page.getByText("Nota de conclusão: Rotina sintética concluída com conferência.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Iniciar atividade", exact: true })).toHaveCount(0);
});

test("the recipient accepts a fragment-only invitation and receives the intended read-only account", async ({ page, browser }, testInfo) => {
  const email = `invite-${testInfo.project.name}-${Date.now()}@example.test`;
  const title = `Consulta autorizada E2E ${email}`;
  await signInAs(page, "vet@cvg.local", GREETING);
  const task = await page.evaluate(async (title) => {
    const csrf = decodeURIComponent(document.cookie.split("; ").find((entry) => entry.startsWith("cvg_csrf="))?.slice("cvg_csrf=".length) ?? "");
    const response = await fetch("/api/v1/hospital-tasks", {
      method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": title },
      body: JSON.stringify({ title, typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE" })
    });
    return { status: response.status, body: await response.json() };
  }, title);
  expect(task.status, JSON.stringify(task.body.error)).toBe(201);
  await signOut(page);
  await signInAs(page, "admin@cvg.local", /Administração técnica/);
  await page.goto("/planner", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Planner fora do seu acesso", exact: true })).toBeVisible();
  const issued = await page.evaluate(async (email) => {
    const options = await fetch("/api/v1/hospital-user-invitations/options");
    const data = (await options.json()).data;
    const viewer = data.groups.find((group: { code: string }) => group.code === "PROFILE_VIEWER");
    if (!viewer) throw new Error("Grupo de consulta não disponível.");
    const csrf = decodeURIComponent(document.cookie.split("; ").find((entry) => entry.startsWith("cvg_csrf="))?.slice("cvg_csrf=".length) ?? "");
    const response = await fetch("/api/v1/hospital-user-invitations", {
      method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": `invite-e2e-${email}` },
      body: JSON.stringify({ email, displayName: "Pessoa convidada E2E", role: "VIEWER", departmentCode: "INPATIENT", accessGroupId: viewer.id, expectedGroupVersion: viewer.version, expiresInHours: 24 })
    });
    return { status: response.status, body: await response.json() };
  }, email);
  expect(issued.status, JSON.stringify(issued.body.error)).toBe(201);
  await signOut(page);
  const { baseURL, extraHTTPHeaders, viewport, isMobile, hasTouch, deviceScaleFactor, locale, timezoneId, colorScheme, userAgent } = testInfo.project.use;
  const recipient = await browser.newContext({ baseURL, extraHTTPHeaders, viewport, isMobile, hasTouch, deviceScaleFactor, locale, timezoneId, colorScheme, userAgent });
  try {
    const receiver = await recipient.newPage(); const urls: string[] = [];
    receiver.on("request", (request) => urls.push(request.url()));
    await receiver.goto(`/invite#${issued.body.data.token}`, { waitUntil: "domcontentloaded" });
    await expect(receiver.getByRole("form", { name: "Aceitar convite operacional", exact: true })).toBeVisible();
    await expect(receiver).toHaveURL(/\/invite$/);
    const password = "Cvg1-SonarBridge-4847!";
    await receiver.getByLabel("Crie sua senha", { exact: true }).fill(password);
    await receiver.getByLabel("Confirme sua senha", { exact: true }).fill(password);
    await receiver.getByRole("button", { name: "Aceitar e criar minha conta", exact: true }).click();
    await expect(receiver.getByRole("heading", { name: "Convite aceito", exact: true })).toBeVisible();
    expect(urls.some((url) => url.includes(issued.body.data.token))).toBe(false);
    await receiver.getByRole("link", { name: "Ir para o login", exact: true }).click();
    await receiver.waitForLoadState("networkidle");
    await receiver.getByLabel("E-mail profissional", { exact: true }).fill(email);
    await receiver.getByLabel("Senha", { exact: true }).fill(password);
    const login = receiver.waitForResponse((response) => response.url().endsWith("/api/v1/session/login") && response.request().method() === "POST");
    await receiver.getByRole("button", { name: "Entrar no Hub", exact: true }).click();
    expect((await login).ok()).toBe(true);
    await expect(receiver).toHaveURL(/\/$/);
    await expect(receiver.getByRole("heading", { name: GREETING })).toBeVisible();
    await openPlannerFromMenu(receiver);
    await expect(receiver.getByRole("button", { name: "Nova atividade", exact: true })).toHaveCount(0);
    await receiver.getByRole("link", { name: title, exact: true }).click();
    await expect(receiver.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(receiver.getByRole("button", { name: "Iniciar atividade", exact: true })).toHaveCount(0);
    await expect(receiver.getByRole("button", { name: "Editar atividade", exact: true })).toHaveCount(0);
    const denied = await receiver.evaluate(async ({ id, version }) => {
      const csrf = decodeURIComponent(document.cookie.split("; ").find((entry) => entry.startsWith("cvg_csrf="))?.slice("cvg_csrf=".length) ?? "");
      const response = await fetch(`/api/v1/hospital-tasks/${id}/commands`, {
        method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": `denied-viewer-${id}` },
        body: JSON.stringify({ command: "START", expectedVersion: version })
      });
      const body = await response.json();
      const current = await fetch(`/api/v1/hospital-tasks/${id}`).then((result) => result.json());
      return { status: response.status, code: body.error?.code, phase: current.data.task.phase, version: current.data.task.version };
    }, { id: task.body.data.task.id, version: task.body.data.task.version });
    expect(denied).toEqual({ status: 404, code: "SCOPE_DENIED", phase: "PENDING", version: task.body.data.task.version });
  } finally { await recipient.close(); }
});
