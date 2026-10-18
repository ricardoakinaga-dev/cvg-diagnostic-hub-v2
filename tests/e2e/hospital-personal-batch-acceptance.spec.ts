import { expect, test, type Locator, type Page } from "@playwright/test";
import type { HospitalTaskView } from "@cvg/contracts";
import { signInAs, signOut } from "./support/auth";

async function write<T>(page: Page, path: string, data: Record<string, unknown>, idempotencyKey = `personal-batch-${Date.now()}-${Math.random()}`): Promise<T> {
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === "cvg_csrf")?.value;
  const response = await page.request.post(`/api/v1${path}`, { headers: { "x-csrf-token": decodeURIComponent(csrf ?? ""), "idempotency-key": idempotencyKey }, data });
  expect(response.ok(), `POST ${path}: ${response.status()}`).toBe(true); return (await response.json()).data as T;
}
async function readTask(page: Page, id: string): Promise<HospitalTaskView> {
  const response = await page.request.get(`/api/v1/hospital-tasks/${id}`); expect(response.status()).toBe(200); return (await response.json()).data;
}
async function task(page: Page, title: string) {
  return write<HospitalTaskView>(page, "/hospital-tasks", { title, typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", responsibleUserId: "user-vet", priority: "ROUTINE" });
}
async function keyboardOpen(page: Page, target: Locator) {
  await expect(target).toBeVisible(); await page.getByRole("combobox", { name: "Mostrar", exact: true }).focus();
  for (let attempts = 0; attempts < 80; attempts += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate(element => element === document.activeElement)) { await page.keyboard.press("Enter"); return; }
  }
  throw new Error("The authorized personal shortcut was not reachable by Tab.");
}

test("normal clinician opens server-authorized favorites and recents by keyboard, while a second identity retains its own private library", async ({ page }, testInfo) => {
  await signInAs(page, "vet@cvg.local");
  const title = `Atalho sintético ${testInfo.project.name} ${Date.now()}`; const created = await task(page, title);
  await page.goto(`/planner/tasks/${created.task.id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Adicionar aos favoritos", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Adicionar aos favoritos", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Remover dos favoritos", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Registrar nos meus recentes", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Registrar nos meus recentes", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Remover dos recentes", exact: true })).toBeVisible();
  const note = `Nota particular sintética ${testInfo.project.name}`;
  await page.getByLabel("Sua nota privada", { exact: true }).fill(note);
  const noteSaved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/work-activity-preferences" && response.request().method() === "PUT" && response.request().postDataJSON()?.privateNote === note);
  await page.getByRole("button", { name: "Salvar nota privada", exact: true }).click();
  expect((await noteSaved).status()).toBe(200);
  await page.goto("/planner/following", { waitUntil: "domcontentloaded" });
  const shortcut = page.getByRole("link", { name: `${created.task.taskCode} · ${title}`, exact: true });
  await expect(page.getByText(note, { exact: true })).toBeVisible();
  await keyboardOpen(page, shortcut); await expect(page).toHaveURL(new RegExp(`/planner/tasks/${created.task.id}$`));
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await page.goto("/planner/following", { waitUntil: "domcontentloaded" });
  await page.getByRole("combobox", { name: "Mostrar", exact: true }).selectOption("RECENTS");
  await keyboardOpen(page, shortcut); await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await signOut(page); await signInAs(page, "manager@cvg.local");
  await page.goto("/planner/following", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Meu acompanhamento", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: `${created.task.taskCode} · ${title}`, exact: true })).toHaveCount(0); await expect(page.getByText(note, { exact: true })).toHaveCount(0);
  await page.goto(`/planner/tasks/${created.task.id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByLabel("Sua nota privada", { exact: true })).toHaveValue("");
});

test("normal clinician measures a mixed batch and reconciles success, a concurrent version conflict, protected active work and idempotent replay with persisted IDs", async ({ page }, testInfo) => {
  await signInAs(page, "vet@cvg.local"); const suffix = `${testInfo.project.name} ${Date.now()}`;
  const terminal = await task(page, `Encerrada sintética ${suffix}`); const active = await task(page, `Pendente protegida ${suffix}`);
  const running = await write<HospitalTaskView>(page, `/hospital-tasks/${terminal.task.id}/commands`, { command: "START", expectedVersion: terminal.task.version });
  const completed = await write<HospitalTaskView>(page, `/hospital-tasks/${terminal.task.id}/commands`, { command: "COMPLETE", expectedVersion: running.task.version });
  const concurrent = await task(page, `Encerrada concorrente ${suffix}`);
  const concurrentRunning = await write<HospitalTaskView>(page, `/hospital-tasks/${concurrent.task.id}/commands`, { command: "START", expectedVersion: concurrent.task.version });
  const concurrentCompleted = await write<HospitalTaskView>(page, `/hospital-tasks/${concurrent.task.id}/commands`, { command: "COMPLETE", expectedVersion: concurrentRunning.task.version });
  // Native API commands above prepare the synthetic tasks; only the interactions below operate the batch through the UI.
  await page.goto("/planner", { waitUntil: "domcontentloaded" }); await expect(page.getByRole("heading", { name: "Planner hospitalar", exact: true })).toBeVisible();
  await page.evaluate(() => { (window as Window & { batchObservedClicks?: string[] }).batchObservedClicks = []; document.addEventListener("click", event => { const element = (event.target as Element | null)?.closest("summary,input,button,select"); if (element) (window as Window & { batchObservedClicks?: string[] }).batchObservedClicks!.push(`${element.tagName}:${element.getAttribute("type") ?? ""}`); }); });
  await page.getByText("Operar atividades em lote", { exact: true }).click();
  const batch = page.locator("details").filter({ has: page.getByText("Operar atividades em lote", { exact: true }) });
  await expect(batch.getByRole("checkbox", { name: `${active.task.taskCode} · ${active.task.title} · versão ${active.task.version}`, exact: true })).toHaveCount(0);
  await batch.getByRole("checkbox", { name: `${completed.task.taskCode} · ${completed.task.title} · versão ${completed.task.version}`, exact: true }).check();
  await batch.getByRole("checkbox", { name: `${concurrentCompleted.task.taskCode} · ${concurrentCompleted.task.title} · versão ${concurrentCompleted.task.version}`, exact: true }).check();
  await batch.getByRole("checkbox", { name: "Confirmo a ação em 2 atividades e aceito resultado por item.", exact: true }).check();
  let concurrentArchived: HospitalTaskView | undefined;
  // Freeze the real UI request, commit another native intent, then deliver the original versions unchanged.
  await page.route("**/api/v1/hospital-tasks/batch", async route => {
    concurrentArchived = await write<HospitalTaskView>(page, `/hospital-tasks/${concurrentCompleted.task.id}/archive`, { archived: true, expectedVersion: concurrentCompleted.task.version });
    await route.continue();
  }, { times: 1 });
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/hospital-tasks/batch" && response.request().method() === "POST");
  await batch.getByRole("button", { name: "Aplicar lote confirmado", exact: true }).click();
  const response = await responsePromise; expect(response.status()).toBe(200); const result = (await response.json()).data;
  expect(result).toMatchObject({ successCount: 1, failureCount: 1 });
  expect(result.items).toHaveLength(2);
  expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: completed.task.id, ok: true }), expect.objectContaining({ taskId: concurrentCompleted.task.id, ok: false, error: expect.objectContaining({ code: "STALE_VERSION", status: 409 }) })]));
  await expect(batch.getByRole("status")).toContainText("1 confirmadas · 1 com falha.");
  const persistedTerminal = await readTask(page, completed.task.id); const persistedActive = await readTask(page, active.task.id);
  expect(persistedTerminal.task).toMatchObject({ id: completed.task.id, phase: "COMPLETED", version: completed.task.version + 1, completedBy: "user-vet" }); expect(persistedTerminal.task.archivedAt).toBeTruthy();
  expect(persistedActive.task).toEqual(active.task);
  expect(concurrentArchived).toBeDefined(); expect((await readTask(page, concurrentCompleted.task.id)).task).toEqual(concurrentArchived!.task);
  const clicks = await page.evaluate(() => (window as Window & { batchObservedClicks?: string[] }).batchObservedClicks ?? []);
  await testInfo.attach("observed-batch-interactions.json", { body: JSON.stringify({ scope: "Five real batch UI clicks, excluding API preparation, deliberate native concurrent commit and native replay; no hospital usability target asserted", observedClicks: clicks, successfulId: completed.task.id, conflictId: concurrentCompleted.task.id, protectedId: active.task.id }), contentType: "application/json" });
  expect(clicks).toHaveLength(5);
  const key = await response.request().headerValue("idempotency-key"); expect(key).toBeTruthy();
  const replay = await write<typeof result>(page, "/hospital-tasks/batch", response.request().postDataJSON(), key!);
  expect(replay).toEqual(result); expect((await readTask(page, completed.task.id)).task).toEqual(persistedTerminal.task); expect((await readTask(page, active.task.id)).task).toEqual(active.task);
  expect((await readTask(page, concurrentCompleted.task.id)).task).toEqual(concurrentArchived!.task);
});
