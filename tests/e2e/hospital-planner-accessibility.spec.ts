import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { HospitalDocumentView, HospitalInstitutionView, HospitalInvitationIssued, HospitalInvitationOptions, HospitalTaskView } from "@cvg/contracts";
import { signInAs, signOut } from "./support/auth";

async function expectNoAxeViolations(page: Page, name: string): Promise<void> {
  const rules = ["aria-allowed-attr", "aria-command-name", "aria-prohibited-attr", "aria-required-attr", "aria-required-children", "aria-required-parent", "aria-roles", "aria-valid-attr", "aria-valid-attr-value", "button-name", "color-contrast", "document-title", "duplicate-id-aria", "html-has-lang", "heading-order", "label", "landmark-one-main", "landmark-unique", "link-name", "nested-interactive", "region", "role-img-alt", "tabindex"];
  const results = await new AxeBuilder({ page }).include("body").withRules(rules).setLegacyMode(true).analyze();
  expect(results.violations, `${name}: ${results.violations.map((violation) => `${violation.id}: ${violation.help}`).join("; ")}`).toEqual([]);
}

async function mutate<T>(page: Page, path: string, method: "POST" | "PUT", data: Record<string, unknown>): Promise<T> {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "cvg_csrf")?.value;
  const response = await page.request.fetch(`/api/v1${path}`, {
    method, headers: { "x-csrf-token": decodeURIComponent(csrf ?? ""), "idempotency-key": `a11y-${Date.now()}-${Math.random()}` }, data
  });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true);
  return (await response.json()).data as T;
}

async function visit(page: Page, path: string, heading: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: heading, exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
}

test("the clinician planner filters and creation dialog retain accessible controls and keyboard focus", async ({ page }) => {
  await signInAs(page, "vet@cvg.local");
  await visit(page, "/planner", "Planner hospitalar");
  const filtered = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/v1/hospital-tasks" && url.searchParams.get("priority") === "ROUTINE";
  });
  await page.getByRole("combobox", { name: "Prioridade", exact: true }).selectOption("ROUTINE");
  expect((await filtered).ok()).toBe(true);
  await expectNoAxeViolations(page, "planner with explicit filters");
  const create = page.getByRole("button", { name: "Nova atividade", exact: true });
  await create.click();
  const dialog = page.getByRole("dialog", { name: "Nova atividade hospitalar", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Título da atividade", exact: true })).toBeFocused();
  await expect(dialog.getByRole("combobox", { name: "Tipo de atividade", exact: true })).toHaveValue("hospital-task-type-routine");
  await expectNoAxeViolations(page, "hospital task creation dialog");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(create).toBeFocused();
});

test("an operational task and its published conversation expose accessible names and landmarks", async ({ page }, testInfo) => {
  await signInAs(page, "vet@cvg.local");
  const title = `Conferência acessível ${testInfo.project.name}-${Date.now()}`;
  const view = await mutate<HospitalTaskView>(page, "/hospital-tasks", "POST", { title, typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE" });
  await visit(page, `/planner/tasks/${view.task.id}`, title);
  const comment = page.getByRole("form", { name: "Adicionar comentário", exact: true });
  await expect(comment).toBeVisible();
  await comment.getByRole("textbox", { name: "Texto do comentário", exact: true }).fill("Material sintético conferido pela equipe.");
  await comment.getByRole("button", { name: "Publicar comentário", exact: true }).click();
  await expect(page.getByText("Material sintético conferido pela equipe.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Anexos da atividade", exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "operational task with published conversation");
});

test("the document library and structured draft preparation are accessible", async ({ page }) => {
  await signInAs(page, "vet@cvg.local");
  await visit(page, "/planner/documents", "Protocolos e documentos");
  await expect(page.getByRole("textbox", { name: "Buscar documento", exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "document library");
  await page.getByRole("button", { name: "Novo documento", exact: true }).click();
  const create = page.getByRole("form", { name: "Criar documento operacional", exact: true });
  await expect(create).toBeVisible();
  await expect(create.getByRole("combobox", { name: "Responsável pelo documento", exact: true })).toBeVisible();
  await expect(create.getByRole("textbox", { name: "Bloco 1, texto 1", exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "structured document draft preparation");
});

test("a document renders real headings, links and table semantics and exposes an accessible draft editor", async ({ page }, testInfo) => {
  await signInAs(page, "vet@cvg.local");
  const title = `Documento acessível ${testInfo.project.name}-${Date.now()}`;
  const view = await mutate<HospitalDocumentView>(page, "/hospital-documents", "POST", {
    code: `A11Y_${testInfo.project.name}_${Date.now()}`, title, departmentCode: "INPATIENT", responsibleUserId: "user-vet",
    content: { type: "hospital-document", version: 1, blocks: [
      { type: "heading", level: 1, content: [{ text: "Conferência operacional" }] },
      { type: "paragraph", content: [{ text: "Referência sintética", href: "https://example.test/policy" }] },
      { type: "table", header: true, rows: [[[{ text: "Etapa" }], [{ text: "Evidência" }]], [[{ text: "Conferir" }], [{ text: "Registro sintético" }]]] }
    ] }
  });
  await visit(page, `/planner/documents/${view.document.id}`, title);
  await expect(page.getByRole("table", { name: "Tabela do documento 3", exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "structured document detail");
  await page.getByRole("button", { name: "Editar rascunho existente", exact: true }).click();
  await expect(page.getByRole("form", { name: "Editar rascunho do documento", exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "structured document draft editor");
});

test("hospital metrics expose accessible period filters and named technical values", async ({ page }) => {
  await signInAs(page, "vet@cvg.local");
  await visit(page, "/planner/metrics", "Indicadores hospitalares");
  await expect(page.getByRole("table", { name: "Definições e valores operacionais", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("form", { name: "Filtrar indicadores hospitalares", exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "hospital metrics and institutional period");
});

test("hospital reports and the definition editor provide accessible controls", async ({ page }) => {
  await signInAs(page, "vet@cvg.local");
  await visit(page, "/planner/reports", "Relatórios hospitalares");
  await expect(page.getByRole("heading", { name: "Minhas exportações", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Nova definição de relatório", exact: true }).click();
  await expect(page.getByRole("form", { name: "Definir relatório hospitalar", exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "hospital report definitions and export jobs");
});

test("administrative department metadata and real team controls are accessible", async ({ page }) => {
  await signInAs(page, "admin@cvg.local", /Administração técnica/);
  await visit(page, "/admin/departments", "Setores");
  await expect(page.getByRole("form", { name: "Criar setor", exact: true })).toBeVisible();
  await expect(page.getByRole("form", { name: "Equipe do setor INPATIENT", exact: true })).toBeVisible({ timeout: 15_000 });
  await expectNoAxeViolations(page, "department directory and persisted teams");
});

test("the access-group matrix and a real effective-access preview are accessible", async ({ page }) => {
  await signInAs(page, "admin@cvg.local", /Administração técnica/);
  await visit(page, "/admin/access-groups", "Grupos e permissões");
  await page.getByRole("combobox", { name: "Colaborador", exact: true }).selectOption("user-vet");
  await page.getByRole("button", { name: "Ver prévia do acesso", exact: true }).click();
  await expect(page.getByRole("region", { name: "Prévia do acesso efetivo", exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "access matrix and contextual preview");
});

test("institution settings and department capability controls are accessible", async ({ page }) => {
  await signInAs(page, "admin@cvg.local", /Administração técnica/);
  const response = await page.request.get("/api/v1/hospital-institution"); expect(response.ok()).toBe(true);
  const current = (await response.json()).data as HospitalInstitutionView;
  await mutate(page, "/hospital-institution", "PUT", { name: "Instituição sintética de acessibilidade", timezone: "America/Sao_Paulo", expectedVersion: current.settings?.version ?? 0 });
  await visit(page, "/admin/institution", "Instituição e capacidades");
  await expect(page.getByRole("form", { name: "Configurar instituição", exact: true })).toBeVisible();
  await expect(page.getByRole("form", { name: "Capacidades de Internação", exact: true })).toBeVisible({ timeout: 15_000 });
  await expectNoAxeViolations(page, "institution settings and department capabilities");
});

test("invitation preparation exposes named role, group, scope and expiry controls", async ({ page }) => {
  await signInAs(page, "admin@cvg.local", /Administração técnica/);
  await visit(page, "/admin/invitations", "Convites operacionais");
  const form = page.getByRole("form", { name: "Emitir convite operacional", exact: true });
  await expect(form.getByRole("button", { name: "Emitir convite", exact: true })).toBeEnabled({ timeout: 15_000 });
  await form.getByRole("combobox", { name: "Perfil convidado", exact: true }).selectOption("VIEWER");
  await form.getByRole("combobox", { name: "Setor do convite", exact: true }).selectOption("INPATIENT");
  await expectNoAxeViolations(page, "scoped invitation preparation");
});

test("disabled integrations retain accessible credential controls without claiming external success", async ({ page }) => {
  await signInAs(page, "admin@cvg.local", /Administração técnica/);
  await visit(page, "/admin/integrations", "Integrações hospitalares");
  await expect(page.getByRole("form", { name: "Emitir credencial de integração", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Emitir token de serviço", exact: true })).toBeDisabled();
  await expect(page.getByText("Desativada: configuração ausente", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  await expectNoAxeViolations(page, "disabled hospital integration configuration");
});

test("a standalone fragment invitation presents accessible password confirmation controls", async ({ page }, testInfo) => {
  await signInAs(page, "admin@cvg.local", /Administração técnica/);
  const response = await page.request.get("/api/v1/hospital-user-invitations/options"); expect(response.ok()).toBe(true);
  const options = (await response.json()).data as HospitalInvitationOptions;
  const group = options.groups.find((entry) => entry.code === "PROFILE_VIEWER"); expect(group).toBeDefined();
  const invitation = await mutate<HospitalInvitationIssued>(page, "/hospital-user-invitations", "POST", {
    email: `a11y-invite-${testInfo.project.name}-${Date.now()}@example.test`, displayName: "Pessoa sintética convidada", role: "VIEWER", departmentCode: "INPATIENT", accessGroupId: group!.id, expectedGroupVersion: group!.version, expiresInHours: 24
  });
  expect(invitation.tokenReturnedOnce).toBe(true); expect(invitation.token).toBeTruthy();
  await signOut(page);
  await page.goto(`/invite#${invitation.token}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("form", { name: "Aceitar convite operacional", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/invite$/);
  await expect(page.getByLabel("Crie sua senha", { exact: true })).toHaveAttribute("autocomplete", "new-password");
  await expect(page.getByLabel("Confirme sua senha", { exact: true })).toHaveAttribute("type", "password");
  await expectNoAxeViolations(page, "fragment-only invitation acceptance");
});
