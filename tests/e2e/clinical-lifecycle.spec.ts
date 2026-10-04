import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signInAs } from "./support/auth";

async function expectNoAxeViolations(page: Page, name: string): Promise<void> {
  const rules = ["aria-allowed-attr", "aria-required-attr", "aria-valid-attr", "button-name", "document-title", "duplicate-id-aria", "html-has-lang", "heading-order", "label", "landmark-one-main", "link-name", "nested-interactive", "role-img-alt", "tabindex"];
  // Pages render per request (CSP nonce); wait for the landmark instead of racing navigation.
  await page.locator("main").first().waitFor({ state: "visible", timeout: 15_000 });
  const results = await new AxeBuilder({ page }).include("main").withRules(rules).setLegacyMode(true).analyze();
  expect(results.violations, `${name}: ${results.violations.map((violation) => `${violation.id}: ${violation.help}`).join("; ")}`).toEqual([]);
}

interface RequestSummary { id: string; requestCode: string; patient: { displayName: string }; items: Array<{ service: { name: string } }> }

async function readApi<T>(page: Page, path: string): Promise<T> {
  const body = await page.evaluate(async (requestPath) => {
    const response = await fetch(`/api/v1${requestPath}`, { headers: { accept: "application/json" } });
    return { ok: response.ok, status: response.status, body: await response.json() as unknown };
  }, path);
  if (!body.ok) throw new Error(`GET ${path} falhou com ${body.status}.`);
  return (body.body as { data: T }).data;
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
}

async function confirmDuplicateIfNeeded(page: Page): Promise<void> {
  const reason = page.getByLabel("Motivo para prosseguir com a duplicidade");
  try {
    await reason.waitFor({ state: "visible", timeout: 1500 });
  } catch {
    return;
  }
  await reason.fill("Repetição controlada para validar o fluxo clínico no ambiente sintético.");
  await page.getByRole("button", { name: /Confirmar duplicidade/ }).click();
}

async function newRequestId(page: Page, previousIds: Set<string>): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const requests = await readApi<RequestSummary[]>(page, "/diagnostic-requests?limit=100");
    const created = requests.find((request) => !previousIds.has(request.id));
    if (created) return created.id;
    await page.waitForTimeout(250);
  }
  throw new Error("A solicitação recém-criada não apareceu na leitura autorizada.");
}

async function createRequest(page: Page, patientId = "patient-thor", encounterId = "encounter-thor"): Promise<string> {
  const previous = await readApi<RequestSummary[]>(page, "/diagnostic-requests?limit=100");
  const previousIds = new Set(previous.map((request) => request.id));
  await page.getByRole("button", { name: /Nova solicitação/ }).click();
  const dialog = page.getByRole("dialog", { name: "Solicitar exames" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "Paciente", exact: true }).selectOption(patientId);
  await expect(dialog.getByLabel("Atendimento")).toBeEnabled();
  await dialog.getByLabel("Atendimento").selectOption(encounterId);
  await dialog.getByText("Hemograma", { exact: true }).click();
  await dialog.getByText("RX de tórax", { exact: true }).click();
  await dialog.getByRole("button", { name: /Confirmar solicitação/ }).click();
  await confirmDuplicateIfNeeded(page);
  await expect(dialog).toBeHidden();
  return newRequestId(page, previousIds);
}

async function queueRow(page: Page, requestId: string, serviceName: string) {
  const request = await readApi<{ requestCode: string }>(page, `/diagnostic-requests/${requestId}`);
  const queueItem = page.locator(".queue-board .queue-card");
  return queueItem.filter({ hasText: serviceName }).filter({ hasText: request.requestCode });
}

async function createAndReleaseDraft(page: Page, requestId: string, serviceName: string, narrative: string): Promise<string> {
  await page.goto("/queues");
  const row = await queueRow(page, requestId, serviceName);
  await expect(row).toBeVisible({ timeout: 15000 });
  if (serviceName === "Hemograma") {
    await row.getByRole("button", { name: "Receber amostra", exact: true }).click();
    const peek = page.getByRole("dialog", { name: serviceName, exact: true });
    await peek.getByLabel("Accession").fill(`ACC-E2E-${Date.now()}`);
    await peek.getByLabel("Tipo de amostra").fill("EDTA");
    await peek.getByRole("button", { name: "Confirmar", exact: true }).click();
    await expect(peek).toBeHidden();
    await row.getByRole("button", { name: "Iniciar processamento", exact: true }).click();
  } else {
    await row.getByRole("button", { name: "Iniciar procedimento", exact: true }).click();
    await row.getByRole("button", { name: "Marcar realizado", exact: true }).click();
  }
  await row.getByRole("button", { name: "Registrar resultado", exact: true }).click();
  const peek = page.getByRole("dialog", { name: serviceName, exact: true });
  await peek.getByLabel("Resultado", { exact: true }).fill(narrative);
  await peek.getByRole("button", { name: "Confirmar", exact: true }).click();
  const draftLink = peek.getByRole("link", { name: "Abrir draft", exact: true });
  await expect(draftLink).toBeVisible();
  const href = await draftLink.getAttribute("href");
  if (!href) throw new Error("O draft não expôs um link de edição.");
  await draftLink.click();
  await expect(page).toHaveURL(/\/results\/result-/);
  const resultId = page.url().split("/").pop();
  if (!resultId) throw new Error("Não foi possível identificar o resultado draft.");
  return resultId;
}

async function fillStructuredHemogram(page: Page, narrative: string): Promise<void> {
  await page.getByRole("button", { name: "Editar draft" }).click();
  await page.getByLabel("Hemoglobina").fill("12.4");
  await page.getByLabel("Leucócitos").fill("8.1");
  await page.getByLabel("Plaquetas").fill("240");
  await page.getByLabel("Observação técnica").fill("Amostra adequada.");
  await page.getByLabel("Narrativa").fill(narrative);
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft atualizado." })).toBeVisible({ timeout: 15000 });
}

test.describe("clinical result lifecycle", () => {
  test("fills a structured hemogram and releases it in one board interaction", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    await signInAs(page, "vet@cvg.local");
    const requestId = await createRequest(page, "patient-mel", "encounter-mel");
    await signOut(page);

    await signInAs(page, "lab@cvg.local");
    const resultId = await createAndReleaseDraft(page, requestId, "Hemograma", "Hemograma estruturado em preenchimento.");
    await expect(page.getByRole("region", { name: /Painel laboratorial Hemograma sintético/ })).toBeVisible();
    await expect(page.getByText("Este draft ainda usa conteúdo legado")).toBeVisible();
    await fillStructuredHemogram(page, "Hemograma estruturado preenchido pelo setor.");
    await expect(page.getByText("Faixa pendente de aprovação").first()).toBeVisible();
    await expect(page.getByText("Não interpretado").first()).toBeVisible();

    const stored = await readApi<{ version: { content: { kind: string; panelCode: string; observations: Array<{ analyteCode: string; value: number | string; flag: string }> } } }>(page, `/results/${resultId}`);
    expect(stored.version.content).toMatchObject({ kind: "LABORATORY_STRUCTURED", panelCode: "SYNTHETIC_HEMOGRAM" });
    expect(stored.version.content.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ analyteCode: "HEMOGLOBIN", value: 12.4, flag: "UNINTERPRETED" }),
      expect.objectContaining({ analyteCode: "PLATELETS", value: 240, flag: "UNINTERPRETED" })
    ]));
    await expectNoAxeViolations(page, "structured laboratory draft");

    await page.goto("/queues");
    const row = await queueRow(page, requestId, "Hemograma");
    await expect(row.getByRole("button", { name: "Liberar resultado", exact: true })).toBeVisible();
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.data/ux-simplification/board-${testInfo.project.name}.png`, fullPage: true });
    let releaseInteractions = 0;
    const releaseResponse = page.waitForResponse((response) => response.url().endsWith(`/api/v1/results/${resultId}/release`) && response.request().method() === "POST");
    await row.getByRole("button", { name: "Liberar resultado", exact: true }).click();
    releaseInteractions += 1;
    expect((await releaseResponse).status()).toBe(200);
    await expect(row.getByText("Resultado disponível", { exact: true })).toBeVisible();
    expect(releaseInteractions).toBe(1);
    expect((await readApi<{ version: { status: string } }>(page, `/results/${resultId}`)).version.status).toBe("RELEASED");
    await testInfo.attach("board-release-interactions", { body: JSON.stringify({ release: releaseInteractions }), contentType: "application/json" });
    await signOut(page);
  });

  test("completes lab and radiology results with verified attachment, notification, review, amendment and void", async ({ page }) => {
    test.setTimeout(120_000);

    await signInAs(page, "vet@cvg.local");
    const requestId = await createRequest(page);
    await signOut(page);

    await signInAs(page, "lab@cvg.local");
    const labResultId = await createAndReleaseDraft(page, requestId, "Hemograma", "Hemograma sem alterações relevantes para o protocolo.");
    await expectNoAxeViolations(page, "lab result draft");
    await fillStructuredHemogram(page, "Hemograma sem alterações relevantes para o protocolo.");
    await page.getByRole("button", { name: "Liberar resultado" }).click();
    await expect(page.getByRole("heading", { name: /Laudo confirmado/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Emendar resultado" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/results/${labResultId}$`));
    await signOut(page);

    await signInAs(page, "rx@cvg.local");
    const xrayResultId = await createAndReleaseDraft(page, requestId, "RX de tórax", "Radiografia sem evidência de alteração aguda.");
    await page.getByLabel("Adicionar anexo (PDF, JPEG ou PNG)").setInputFiles({
      name: "thor-report.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF")
    });
    await page.getByRole("button", { name: "Enviar anexo" }).click();
    await expect(page.getByRole("status", { name: "" }).filter({ hasText: "Anexo enviado, verificado e finalizado." })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("thor-report.pdf", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Liberar resultado" }).click();
    await expect(page.getByRole("heading", { name: /Laudo confirmado/ })).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Baixar" }).click();
    await expect((await downloadPromise).suggestedFilename()).toBe("thor-report.pdf");

    await signOut(page);
    await signInAs(page, "vet@cvg.local");
    await page.goto("/notifications");
    const resultNotification = page.locator(".inbox-row").filter({ hasText: "Resultado disponível" }).filter({ hasText: "RX de tórax" }).first();
    await expect(resultNotification).toBeVisible({ timeout: 15000 });
    await resultNotification.getByRole("link", { name: "Abrir contexto" }).click();
    await expect(page).toHaveURL(new RegExp(`/results/${xrayResultId}$`));
    await expectNoAxeViolations(page, "released result");
    await expect(page.getByText("Visualização registrada")).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Marcar como revisado" }).click();
    await expect(page.getByText("Revisado", { exact: true })).toBeVisible({ timeout: 15000 });
    await signOut(page);

    await signInAs(page, "rx@cvg.local");
    await page.goto(`/results/${xrayResultId}`);
    await page.getByRole("button", { name: "Emendar resultado" }).click();
    await page.getByLabel("Motivo").fill("Correção de interpretação no laudo.");
    await page.getByLabel("Narrativa").fill("Radiografia revisada sem evidência de alteração aguda.");
    await page.getByLabel("Conclusão").fill("Sem alteração aguda.");
    await page.getByRole("button", { name: "Confirmar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Draft em edição" })).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Liberar resultado" }).click();
    await expect(page.getByRole("heading", { name: /Laudo confirmado/ })).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Invalidar" }).click();
    await page.getByLabel("Motivo").fill("Invalidação controlada para correção clínica.");
    await page.getByRole("button", { name: "Confirmar", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Resultado invalidado" })).toBeVisible({ timeout: 15000 });
    await page.goto("/queues");
    const replacementRow = await queueRow(page, requestId, "RX de tórax");
    await expect(replacementRow.getByRole("button", { name: "Registrar resultado" })).toBeVisible({ timeout: 15000 });
    await replacementRow.getByRole("button", { name: "Registrar resultado" }).click();
    const replacementPeek = page.getByRole("dialog", { name: "RX de tórax", exact: true });
    await replacementPeek.getByLabel("Resultado", { exact: true }).fill("Laudo substituto após invalidação controlada.");
    await replacementPeek.getByRole("button", { name: "Confirmar", exact: true }).click();
    await replacementPeek.getByRole("link", { name: "Abrir draft" }).click();
    await expect(page.getByRole("heading", { name: "Draft em edição" })).toBeVisible();
    const replacementReleaseResponse = page.waitForResponse((response) => response.url().endsWith(`/api/v1/results/${xrayResultId}/release`) && response.request().method() === "POST");
    await page.getByRole("button", { name: "Liberar resultado" }).click();
    const replacementRelease = await replacementReleaseResponse;
    if (!replacementRelease.ok()) throw new Error(`Liberação substituta falhou: ${await replacementRelease.text()}`);
    await expect(page.getByRole("heading", { name: /Laudo confirmado/ })).toBeVisible({ timeout: 15000 });
    await signOut(page);
  });

  test("requires critical acknowledgement before review", async ({ page }) => {
    test.setTimeout(120_000);

    await signInAs(page, "vet@cvg.local");
    const requestId = await createRequest(page, "patient-mel", "encounter-mel");
    await signOut(page);

    await signInAs(page, "lab@cvg.local");
    const resultId = await createAndReleaseDraft(page, requestId, "Hemograma", "Resultado crítico sintético para validar confirmação.");
    await fillStructuredHemogram(page, "Resultado crítico sintético para validar confirmação.");
    await page.getByLabel("Liberar como resultado crítico").check();
    await page.getByRole("button", { name: "Liberar resultado" }).click();
    await expect(page.getByRole("heading", { name: "Resultado crítico" })).toBeVisible({ timeout: 15000 });
    await signOut(page);

    await signInAs(page, "vet@cvg.local");
    await page.goto("/notifications");
    const criticalNotification = page.locator(".inbox-row").filter({ hasText: "Resultado crítico requer confirmação" }).filter({ hasText: "Hemograma" }).first();
    await expect(criticalNotification).toBeVisible({ timeout: 15000 });
    await expectNoAxeViolations(page, "critical notification");
    await criticalNotification.getByLabel("Motivo da confirmação").fill("Confirmei o resultado crítico no contexto do atendimento.");
    await criticalNotification.getByRole("checkbox").check();
    await criticalNotification.getByRole("button", { name: "Confirmar" }).click();
    await expect(criticalNotification).toHaveClass(/is-acknowledged/, { timeout: 15000 });
    await criticalNotification.getByRole("link", { name: "Abrir contexto" }).click();
    await expect(page).toHaveURL(new RegExp(`/results/${resultId}$`));
    await expectNoAxeViolations(page, "critical result");
    await expect(page.getByText("Visualização registrada")).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Marcar como revisado" }).click();
    await expect(page.getByText("Revisado", { exact: true })).toBeVisible({ timeout: 15000 });
  });
});
