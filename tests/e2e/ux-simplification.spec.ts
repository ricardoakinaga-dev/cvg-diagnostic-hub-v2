import { expect, test, type Locator } from "@playwright/test";
import { GREETING, signInAs, signOut } from "./support/auth";
import { seedHemogramRequest } from "./support/seed";

class InteractionCounter {
  count = 0;
  async fill(control: Locator, value: string) { await control.fill(value); this.count += 1; }
  async select(control: Locator, value: string) { await control.selectOption(value); this.count += 1; }
  async click(control: Locator) { await control.click(); this.count += 1; }
}

test("recovers a collaborator with Gerar nova senha, revokes active access and forces a new personal password", async ({ page, browser }, testInfo) => {
  const email = `recovery-${Date.now()}-${testInfo.project.name}@cvg.local`;
  await signInAs(page, "admin@cvg.local", /Administração técnica/);
  await page.goto("/admin#users");
  const create = page.getByRole("form", { name: "Adicionar colaborador" });
  await create.getByLabel("Nome completo").fill("Colaborador recuperação");
  await create.getByLabel("E-mail institucional").fill(email);
  await create.getByLabel("Perfil").selectOption("VIEWER");
  await create.getByRole("button", { name: "Criar acesso" }).click();
  const initialDialog = page.getByRole("dialog", { name: "Senha inicial", exact: true });
  const initialSecret = await initialDialog.getByLabel("Senha inicial gerada").textContent();
  await initialDialog.getByRole("button", { name: "Fechar", exact: true }).click();
  const peer = await browser.newContext({ baseURL: testInfo.project.use.baseURL, extraHTTPHeaders: testInfo.project.use.extraHTTPHeaders });
  try {
    expect((await peer.request.post("/api/v1/session/login", { data: { email, password: initialSecret } })).status()).toBe(200);
    const csrf = (await peer.cookies()).find((cookie) => cookie.name === "cvg_csrf")!.value;
    expect((await peer.request.post("/api/v1/session/password", { headers: { "x-csrf-token": csrf }, data: { password: "Previous-personal-password-2026" } })).status()).toBe(200);
    await page.reload();
    const row = page.getByRole("form", { name: `Acesso de ${email}`, exact: true });
    await expect(row).toBeVisible();
    let resetCommands = 0;
    page.on("request", (request) => { if (/\/users\/[^/]+\/password$/.test(request.url()) && request.method() === "POST") resetCommands += 1; });
    await row.getByRole("button", { name: "Gerar nova senha", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Gerar nova senha", exact: true });
    await expect(confirmation).toContainText("as sessões serão encerradas");
    await confirmation.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    expect(resetCommands).toBe(0);
    const reset = page.waitForResponse((response) => /\/users\/[^/]+\/password$/.test(response.url()) && response.request().method() === "POST");
    await row.getByRole("button", { name: "Gerar nova senha", exact: true }).click();
    await page.getByRole("dialog", { name: "Gerar nova senha", exact: true }).getByRole("button", { name: "Gerar nova senha", exact: true }).click();
    const response = await reset;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({ expectedVersion: 2 });
    expect(response.request().headers()["x-csrf-token"]).toBeTruthy();
    expect(resetCommands).toBe(1);
    const dialog = page.getByRole("dialog", { name: "Nova senha temporária", exact: true });
    await expect(dialog).toBeVisible();
    const regenerated = await dialog.getByLabel("Senha inicial gerada").textContent();
    expect(regenerated).not.toBe(initialSecret);
    await page.screenshot({ path: `.data/ux-simplification/password-recovery-${testInfo.project.name}.png`, fullPage: false });
    expect((await peer.request.get("/api/v1/session/me")).status()).toBe(401);
    expect((await peer.request.post("/api/v1/session/login", { data: { email, password: "Previous-personal-password-2026" } })).status()).toBe(401);
    await dialog.getByRole("button", { name: "Fechar", exact: true }).click();
    await expect(row.getByRole("button", { name: "Gerar nova senha", exact: true })).toBeFocused();
    await page.reload();
    await expect(page.getByRole("dialog", { name: "Nova senha temporária", exact: true })).toHaveCount(0);
    await expect(page.getByText(regenerated!, { exact: true })).toHaveCount(0);
    await signOut(page);
    await page.getByLabel("E-mail profissional").fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(regenerated!);
    await page.getByRole("button", { name: "Entrar no Hub" }).click();
    await expect(page.getByRole("heading", { name: "Crie sua senha" })).toBeVisible();
    expect((await page.request.get("/api/v1/dashboard")).status()).toBe(403);
    await page.getByLabel("Nova senha", { exact: true }).fill("Recovered-personal-password-2026");
    await page.getByLabel("Confirmar nova senha").fill("Recovered-personal-password-2026");
    await page.getByRole("button", { name: "Salvar nova senha" }).click();
    await expect(page).toHaveURL(/\/$/);
    await testInfo.attach("recovery-interactions", { body: JSON.stringify({ generate: 1, confirmation: 1, total: 2 }), contentType: "application/json" });
  } finally { await peer.close(); }
});

test("creates in four interactions, changes department in two and enforces the generated-password lifecycle", async ({ page, browser }, testInfo) => {
  const email = `ux-${Date.now()}-${testInfo.project.name}@cvg.local`;
  await seedHemogramRequest(browser, testInfo, "ux-seed");
  await signInAs(page, "admin@cvg.local", /Administração técnica/);
  await page.goto("/admin#users");
  const create = page.getByRole("form", { name: "Adicionar colaborador" });
  const creation = new InteractionCounter();
  await creation.fill(create.getByLabel("Nome completo"), "Colaborador UX");
  await creation.fill(create.getByLabel("E-mail institucional"), email);
  await creation.select(create.getByLabel("Perfil"), "VIEWER");
  await creation.click(create.getByRole("button", { name: "Criar acesso" }));
  expect(creation.count).toBeLessThanOrEqual(4);
  const dialog = page.getByRole("dialog", { name: "Senha inicial", exact: true });
  await expect(dialog).toBeVisible();
  const secret = await dialog.getByLabel("Senha inicial gerada").textContent();
  expect(secret?.length).toBeGreaterThanOrEqual(12);
  await dialog.getByRole("button", { name: "Fechar", exact: true }).click();
  const row = page.getByRole("form", { name: `Acesso de ${email}`, exact: true });
  await expect(row.getByRole("combobox", { name: "Setor", exact: true })).toHaveValue("IT");
  const edit = new InteractionCounter();
  await edit.select(row.getByRole("combobox", { name: "Setor", exact: true }), "LABORATORY");
  await edit.click(row.getByRole("button", { name: `Salvar ${email}`, exact: true }));
  expect(edit.count).toBeLessThanOrEqual(2);
  await expect(row.getByRole("combobox", { name: "Setor", exact: true })).toHaveValue("LABORATORY");
  await row.getByRole("button", { name: "Desativar acesso" }).click();
  await expect(row.getByText("Desativado", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Desfazer" }).click();
  await expect(row.getByText("Ativo", { exact: true })).toBeVisible();
  await row.getByRole("combobox", { name: "Perfil", exact: true }).selectOption("ADMIN");
  await row.getByRole("button", { name: `Salvar ${email}`, exact: true }).click();
  const stepUp = page.getByRole("dialog", { name: "Confirmar alteração de ADMIN", exact: true });
  await expect(stepUp).toBeVisible();
  await page.screenshot({ path: `.data/ux-simplification/reauth-${testInfo.project.name}.png`, fullPage: false });
  await stepUp.getByLabel("Senha para reautenticar").fill("e2e-local-password-2026");
  await stepUp.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(stepUp).toBeHidden();
  await expect(row.getByRole("combobox", { name: "Perfil", exact: true })).toHaveValue("ADMIN");
  await row.getByRole("combobox", { name: "Perfil", exact: true }).selectOption("VIEWER");
  await row.getByRole("button", { name: `Salvar ${email}`, exact: true }).click();
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel("Senha para reautenticar").fill("e2e-local-password-2026");
  await stepUp.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(stepUp).toBeHidden();
  await row.getByRole("combobox", { name: "Perfil", exact: true }).selectOption("LAB_TECH");
  await row.getByText(/^Exames autorizados/).click();
  await row.getByRole("checkbox", { name: "Hemograma", exact: true }).check();
  const assigned = page.waitForResponse((response) => response.url().includes("/roles") && response.request().method() === "POST");
  await row.getByRole("button", { name: `Salvar ${email}`, exact: true }).click();
  expect((await assigned).status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Senha inicial", exact: true })).toHaveCount(0);
  const audit = await page.request.get("/api/v1/audit-events?limit=100");
  expect(audit.status()).toBe(200);
  expect((await audit.json()).data).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "UserCreated", actorId: "user-admin" })]));
  await signOut(page);
  await page.getByLabel("E-mail profissional").fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(secret!);
  await page.getByRole("button", { name: "Entrar no Hub" }).click();
  await expect(page.getByRole("heading", { name: "Crie sua senha" })).toBeVisible();
  expect((await page.request.get("/api/v1/dashboard")).status()).toBe(403);
  await page.getByLabel("Nova senha", { exact: true }).fill("My-personal-password-2026");
  await page.getByLabel("Confirmar nova senha").fill("My-personal-password-2026");
  await page.getByRole("button", { name: "Salvar nova senha" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Crie sua senha" })).toHaveCount(0);
  expect((await page.request.get("/api/v1/session/me")).status()).toBe(200);
  const queue = await page.request.get("/api/v1/queues/LABORATORY/items");
  expect(queue.status()).toBe(200);
  const queueBody = await queue.json() as { data: Array<{ service: { code: string } }> };
  expect(queueBody.data.length).toBeGreaterThan(0);
  expect(queueBody.data.every((item) => item.service.code === "HEMOGRAM")).toBe(true);
  await testInfo.attach("interaction-counts", { body: JSON.stringify({ userCreation: creation.count, departmentChange: edit.count }), contentType: "application/json" });
});

test("creates a catalog exam using only its name and duplicates a numeric panel with the real template", async ({ page }, testInfo) => {
  await signInAs(page, "admin@cvg.local", /Administração técnica/);
  await page.goto("/admin#catalog");
  const name = `Exame UX ${Date.now()} ${testInfo.project.name}`;
  const create = page.getByRole("form", { name: "Adicionar serviço", exact: true });
  const interactions = new InteractionCounter();
  await interactions.fill(create.getByLabel("Nome", { exact: true }), name);
  const created = page.waitForResponse((response) => response.url().endsWith("/api/v1/diagnostic-services") && response.request().method() === "POST");
  await interactions.click(create.getByRole("button", { name: "Criar serviço", exact: true }));
  const response = await created;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({ name, departmentCode: "LABORATORY", slaHours: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 } });
  expect(interactions.count).toBe(2);
  await expect(page.getByRole("form", { name: `Serviço ${name}`, exact: true })).toBeVisible();
  const hemogram = page.getByRole("form", { name: "Serviço Hemograma", exact: true });
  const duplicated = page.waitForResponse((result) => result.url().endsWith("/api/v1/diagnostic-services") && result.request().method() === "POST");
  await hemogram.getByRole("button", { name: "Duplicar Hemograma", exact: true }).click();
  const copy = await duplicated;
  expect(copy.status()).toBe(201);
  const body = await copy.json() as { data: { resultSchema: string; resultTemplate: { code: string; status: string } } };
  expect(body.data).toMatchObject({ resultSchema: "NUMERIC_PANEL", resultTemplate: { code: "SYNTHETIC_HEMOGRAM", status: "ACTIVE" } });
  await expect(page.getByRole("form", { name: "Serviço Hemograma (cópia)", exact: true })).toBeVisible();
  await testInfo.attach("catalog-interactions", { body: JSON.stringify({ creation: interactions.count, enteredFields: ["name"] }), contentType: "application/json" });
});

test("registers a patient with three fields through the global shortcut and searches authorized records", async ({ page }, testInfo) => {
  await signInAs(page, "vet@cvg.local", GREETING);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Atalhos e busca" });
  await expect(palette).toBeVisible();
  await palette.getByRole("option", { name: /Novo paciente/ }).click();
  const patient = page.getByRole("dialog", { name: "Cadastrar paciente" });
  await expect(patient.getByLabel("Ala ou unidade")).toHaveCount(0);
  await page.screenshot({ path: `.data/ux-simplification/patient-${testInfo.project.name}.png`, fullPage: false });
  await patient.getByLabel("Nome do paciente").fill(`Amora UX ${testInfo.project.name}`);
  await patient.getByLabel("Espécie", { exact: true }).fill("Canino");
  await patient.getByLabel("Tutor ou responsável").fill("Tutor UX");
  await patient.getByRole("button", { name: "Confirmar cadastro de paciente" }).click();
  await expect(patient).toBeHidden();
  await page.keyboard.press("Control+k");
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox").fill("Thor");
  await expect(palette.getByText("Thor", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: `.data/ux-simplification/palette-${testInfo.project.name}.png`, fullPage: false });
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await page.keyboard.press("Control+k");
  await palette.getByRole("option", { name: /Novo exame/ }).click();
  await expect(page).toHaveURL(/\/queues/);
  const request = page.getByRole("dialog", { name: "Solicitar exames" });
  await expect(request).toBeVisible();
  await expect(request.getByText("Hemograma", { exact: true })).toBeVisible();
  await page.screenshot({ path: `.data/ux-simplification/new-exam-${testInfo.project.name}.png`, fullPage: false });
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "cvg_csrf")?.value;
  expect(csrf).toBeTruthy();
  const targetName = `Paciente além da lista ${Date.now()} ${testInfo.project.name}`;
  let targetId = "";
  for (let index = 0; index < 101; index += 1) {
    const response = await page.request.post("/api/v1/patients", {
      headers: { "x-csrf-token": csrf!, "idempotency-key": `patient-search-${testInfo.project.name}-${Date.now()}-${index}` },
      data: { displayName: index === 100 ? targetName : `Paciente de busca ${testInfo.project.name} ${index}`, species: "Canino", breed: "Não informado", sex: "UNKNOWN", ownerLabel: "Tutor sintético", encounterType: "OUTPATIENT" }
    });
    expect(response.status()).toBe(201);
    if (index === 100) targetId = (await response.json() as { data: { patient: { id: string } } }).data.patient.id;
  }
  const firstPage = await page.request.get("/api/v1/patients");
  expect(firstPage.status()).toBe(200);
  const initialPatients = (await firstPage.json() as { data: Array<{ id: string }> }).data;
  expect(initialPatients).toHaveLength(100);
  expect(initialPatients.some((patient) => patient.id === targetId)).toBe(false);
  await request.getByLabel("Buscar pacientes", { exact: true }).fill(targetName);
  await expect(request.getByRole("option", { name: new RegExp(targetName) })).toHaveCount(1);
  await request.getByLabel("Paciente", { exact: true }).selectOption(targetId);
  const encounter = request.getByRole("combobox", { name: "Atendimento", exact: true });
  await expect(encounter).toBeEnabled();
  const encounterId = await encounter.locator("option").nth(1).getAttribute("value");
  expect(encounterId).toBeTruthy();
  await encounter.selectOption(encounterId!);
  await request.getByRole("checkbox", { name: "Hemograma Laboratório", exact: true }).check();
  const created = page.waitForResponse((response) => response.url().endsWith("/api/v1/diagnostic-requests") && response.request().method() === "POST");
  await request.getByRole("button", { name: "Confirmar solicitação", exact: true }).click();
  const createdResponse = await created;
  expect(createdResponse.status()).toBe(201);
  const createdId = (await createdResponse.json() as { data: { id: string } }).data.id;
  await expect(request).toBeHidden();
  await page.keyboard.press("Control+k");
  await palette.getByRole("combobox").fill("Hemograma");
  const exam = palette.getByRole("option").filter({ hasText: "HEMOGRAM" }).filter({ hasText: targetName });
  await expect(exam).toBeVisible();
  await exam.click();
  await expect(page).toHaveURL(new RegExp(`/requests/${createdId}`));
});

test("keeps technical data in ADMIN System and revokes a real session with one click and confirmation", async ({ page, playwright }, testInfo) => {
  const peer = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL, extraHTTPHeaders: testInfo.project.use.extraHTTPHeaders });
  try {
    const login = await peer.post("/api/v1/session/login", { data: { email: "vet@cvg.local", password: "e2e-local-password-2026" } });
    expect(login.status()).toBe(200);
    await signInAs(page, "admin@cvg.local", /Administração técnica/);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Administração", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Atualizar", exact: true })).toBeEnabled();
    await expect(page.getByRole("form", { name: "Serviço Hemograma", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Auditoria recente" })).toHaveCount(0);
    await page.screenshot({ path: `.data/ux-simplification/admin-${testInfo.project.name}.png`, fullPage: true });
    await page.goto("/system");
    const row = page.locator("#sessions .admin-row").filter({ hasText: "vet@cvg.local" }).filter({ has: page.getByRole("button", { name: "Revogar sessão", exact: true }) }).first();
    await expect(row).toBeVisible();
    await expect(row.getByLabel("Senha para reautenticar")).toHaveCount(0);
    const revoked = page.waitForResponse((response) => /\/sessions\/[^/]+\/revoke$/.test(response.url()) && response.request().method() === "POST");
    await row.getByRole("button", { name: "Revogar sessão", exact: true }).click();
    await page.getByRole("dialog", { name: "Revogar sessão", exact: true }).getByRole("button", { name: "Revogar", exact: true }).click();
    expect((await revoked).status()).toBe(200);
    expect((await peer.get("/api/v1/session/me")).status()).toBe(401);
    await expect(page.getByRole("heading", { name: "Auditoria recente", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Atualizar", exact: true })).toBeEnabled();
    const auditRows = page.locator("#audit li");
    await expect(auditRows.first()).toBeVisible();
    for (const auditRow of await auditRows.all()) {
      const content = await auditRow.locator("strong").boundingBox();
      const status = await auditRow.locator(".admin-audit-state").boundingBox();
      const bounds = await auditRow.boundingBox();
      expect(content).not.toBeNull();
      expect(status).not.toBeNull();
      expect(bounds).not.toBeNull();
      expect(content!.width).toBeGreaterThan(60);
      expect(content!.x + content!.width).toBeLessThanOrEqual(status!.x);
      expect(status!.x + status!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    }
    await page.screenshot({ path: `.data/ux-simplification/system-${testInfo.project.name}.png`, fullPage: true });
    await signOut(page);
    await signInAs(page, "manager@cvg.local", GREETING);
    await page.goto("/system");
    await expect(page.getByRole("heading", { name: "Sistema restrito à administração técnica" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Auditoria recente" })).toHaveCount(0);
  } finally { await peer.dispose(); }
});

test("quick-add submits with Enter and moving to recollection requires a reason from the list", async ({ page }, testInfo) => {
  const patientName = `Paciente board ${Date.now()} ${testInfo.project.name}`;
  await signInAs(page, "vet@cvg.local", GREETING);
  await page.keyboard.press("Control+k");
  await page.getByRole("option", { name: /Novo paciente/ }).click();
  const patientDialog = page.getByRole("dialog", { name: "Cadastrar paciente" });
  await patientDialog.getByLabel("Nome do paciente").fill(patientName);
  await patientDialog.getByLabel("Espécie", { exact: true }).fill("Canino");
  await patientDialog.getByLabel("Tutor ou responsável").fill("Tutor do board");
  const patientResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/patients") && response.request().method() === "POST");
  await patientDialog.getByRole("button", { name: "Confirmar cadastro de paciente" }).click();
  const patientBody = await (await patientResponse).json() as { data: { patient: { id: string } } };
  await expect(patientDialog).toBeHidden();
  await page.goto("/queues");
  // Plane's inline "New work item" row at the end of the Solicitado group.
  await page.locator(".quick-add").first().click();
  const quickAdd = page.getByRole("form", { name: "Adicionar exame à fila" });
  await quickAdd.getByLabel("Buscar paciente", { exact: true }).fill(patientName);
  await expect(quickAdd.getByRole("option", { name: new RegExp(patientName) })).toHaveCount(1);
  await quickAdd.getByLabel("Paciente", { exact: true }).selectOption(patientBody.data.patient.id);
  await quickAdd.getByLabel("Exame", { exact: true }).selectOption({ label: "Hemograma" });
  await expect(quickAdd.getByRole("button", { name: "Adicionar exame" })).toBeEnabled();
  const requestResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/diagnostic-requests") && response.request().method() === "POST");
  await quickAdd.getByLabel("Exame", { exact: true }).press("Enter");
  expect((await requestResponse).status()).toBe(201);
  await signOut(page);
  await signInAs(page, "lab@cvg.local");
  await page.goto("/queues");
  const row = page.locator("[data-item-row]").filter({ hasText: patientName });
  await row.getByRole("button", { name: "Receber amostra", exact: true }).click();
  const peek = page.getByRole("dialog", { name: "Hemograma", exact: true });
  // D8: the pre-assigned tube is received with the accession left empty; the demo catalog has no
  // sample type for the hemogram, so the technician types it.
  await expect(peek.getByText(/Amostra esperada:/)).toBeVisible();
  await peek.getByLabel("Tipo de amostra").fill("EDTA");
  await peek.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(peek.getByRole("button", { name: "Iniciar processamento", exact: true })).toBeVisible();
  await peek.getByRole("button", { name: "Fechar contexto" }).click();
  await expect(peek).toBeHidden();
  await expect(row.getByRole("button", { name: "Iniciar processamento", exact: true })).toBeEnabled();
  const processing = page.waitForResponse((response) => response.url().endsWith("/start-processing") && response.request().method() === "POST");
  const moveTo = async (state: string) => {
    await row.getByRole("button", { name: /^Estado: .*Mudar estado$/ }).click();
    await page.getByRole("menu", { name: `Mover Hemograma de ${patientName}`, exact: true }).getByRole("menuitem", { name: state, exact: true }).click();
  };
  if (testInfo.project.name !== "chromium") await moveTo("Em execução");
  else {
    await page.getByRole("radio", { name: "Quadro" }).click();
    // Cards are not draggable while the board refreshes after the previous command; wait for it.
    await expect(row).toHaveAttribute("draggable", "true");
    // Drag from the card's padding to the column heading. The centers of tall
    // cards/columns can scroll the page mid-gesture and cancel a native drag.
    const destination = page.getByRole("region", { name: "Em execução", exact: true })
      .getByRole("heading", { name: "Em execução", exact: true });
    await destination.scrollIntoViewIfNeeded();
    await row.dragTo(destination, { sourcePosition: { x: 8, y: 8 } });
  }
  expect((await processing).status()).toBe(200);
  await expect(row.getByText("Em execução", { exact: true })).toBeVisible();
  await moveTo("Recoleta necessária");
  await expect(peek.getByRole("combobox", { name: "Motivo", exact: true })).toBeVisible();
  await expect(peek.getByRole("button", { name: "Confirmar", exact: true })).toBeDisabled();
  await expect(peek.getByRole("textbox", { name: "Motivo", exact: true })).toHaveCount(0);
  await peek.getByRole("combobox", { name: "Motivo", exact: true }).selectOption({ label: "Amostra hemolisada" });
  await expect(page.locator(".mobile-nav")).toHaveAttribute("inert");
  const confirm = peek.getByRole("button", { name: "Confirmar", exact: true });
  await confirm.scrollIntoViewIfNeeded();
  expect(await confirm.evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    const topmost = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    return button.contains(topmost);
  })).toBe(true);
  await page.screenshot({ path: `.data/ux-simplification/recollection-${testInfo.project.name}.png`, fullPage: false });
  const recollection = page.waitForResponse((response) => response.url().endsWith("/request-recollection") && response.request().method() === "POST");
  await peek.getByRole("button", { name: "Confirmar", exact: true }).click();
  const command = await recollection;
  expect(command.request().postDataJSON()).toMatchObject({ reasonCode: "HEMOLYZED", expectedVersion: expect.any(Number) });
  expect(command.status()).toBe(200);
  await expect(row.getByText("Recoleta necessária", { exact: true })).toBeVisible();
});

test("exports a patient's records for the data subject as a downloaded file (PROD-502)", async ({ page }, testInfo) => {
  await signInAs(page, "admin@cvg.local", /Administração técnica/);
  await page.goto("/admin#privacy");
  await expect(page.getByRole("heading", { name: "Privacidade (LGPD)", exact: true })).toBeVisible();
  await page.getByText("Exportar dados do titular (LGPD)", { exact: true }).click();
  await page.getByLabel("Número do prontuário").fill("HIS-THOR-001");
  await page.getByLabel("Sua senha (confirmação)").fill("e2e-local-password-2026");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exportar", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^titular-HIS-THOR-001-\d{4}-\d{2}-\d{2}\.json$/);
  const saved = testInfo.outputPath("export.json");
  await file.saveAs(saved);
  const { readFile } = await import("node:fs/promises");
  const exported = JSON.parse(await readFile(saved, "utf8")) as { format: string; patient: { externalId: string }; omitted: string[] };
  expect(exported.format).toBe("cvg-hub.patient-data-export.v1");
  expect(exported.patient.externalId).toBe("HIS-THOR-001");
  expect(exported.omitted.length).toBeGreaterThan(0);
  await expect(page.getByRole("status").filter({ hasText: "Exportação de HIS-THOR-001 gerada e registrada na auditoria" })).toBeVisible();
  // The password field is cleared and the content never reaches the page.
  await expect(page.getByLabel("Sua senha (confirmação)")).toHaveValue("");
  await expect(page.getByText("cvg-hub.patient-data-export.v1")).toHaveCount(0);
});
