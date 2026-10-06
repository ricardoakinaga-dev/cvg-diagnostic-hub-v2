import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { GREETING, signInAs, signOut } from "./support/auth";

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await signInAs(page, "vet@cvg.local");
}

async function expectNoAxeViolations(page: import("@playwright/test").Page, name: string): Promise<void> {
  const rules = ["aria-allowed-attr", "aria-command-name", "aria-prohibited-attr", "aria-required-attr", "aria-required-children", "aria-required-parent", "aria-roles", "aria-valid-attr", "aria-valid-attr-value", "button-name", "color-contrast", "document-title", "duplicate-id-aria", "html-has-lang", "heading-order", "label", "landmark-one-main", "landmark-unique", "link-name", "nested-interactive", "region", "role-img-alt", "tabindex"];
  const results = await new AxeBuilder({ page }).include("body").withRules(rules).setLegacyMode(true).analyze();
  expect(results.violations, `${name}: ${results.violations.map((violation) => `${violation.id}: ${violation.help}`).join("; ")}`).toEqual([]);
}

test.describe("accessible operational surfaces", () => {
  test("login, dashboard, queue and notifications have no axe violations", async ({ page }) => {
    await page.goto("/login");
    await expectNoAxeViolations(page, "login");
    await signIn(page);
    await expectNoAxeViolations(page, "dashboard");

    // Give the clinician at least one exam so list, board and peek are all audited.
    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "cvg_csrf")?.value;
    const seeded = await page.request.post("/api/v1/diagnostic-requests", {
      headers: { "x-csrf-token": csrf ?? "", "idempotency-key": `a11y-seed-${Date.now()}` },
      data: { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }
    });
    expect([201, 409]).toContain(seeded.status());
    await page.goto("/queues");
    await expect(page.getByRole("heading", { name: "Todos os exames" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Abrir Hemograma — Thor/ }).first()).toBeVisible();
    await expectNoAxeViolations(page, "queues list");
    await page.getByRole("radio", { name: "Quadro" }).click();
    await expect(page.getByLabel("Quadro de exames")).toBeVisible();
    await expectNoAxeViolations(page, "queues board");
    await page.getByRole("button", { name: /^Abrir Hemograma — Thor/ }).first().click();
    await expect(page.getByRole("dialog", { name: "Hemograma" })).toBeVisible();
    await expectNoAxeViolations(page, "queues peek");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Hemograma" })).toBeHidden();
    await page.getByRole("radio", { name: "Lista" }).click();

    await page.goto("/notifications");
    await expect(page.getByRole("heading", { name: "Caixa de entrada" })).toBeVisible();
    await expectNoAxeViolations(page, "notifications");

    await page.goto("/patients");
    await expect(page.getByRole("heading", { name: "Pacientes" })).toBeVisible();
    await expectNoAxeViolations(page, "patients");

    await page.goto("/patients/patient-thor/diagnostics");
    await expect(page.getByRole("heading", { name: /Thor/ })).toBeVisible();
    await expectNoAxeViolations(page, "patient diagnostics");

    await page.goto("/indicators");
    await expect(page.getByRole("heading", { name: /Indicadores/ })).toBeVisible();
    await expectNoAxeViolations(page, "indicators");
  });

  test("account, management and administration surfaces have no axe violations", async ({ page }) => {
    await signInAs(page, "manager@cvg.local", GREETING);

    await page.goto("/account");
    await expect(page.getByRole("heading", { name: /Minha conta/ })).toBeVisible();
    await expectNoAxeViolations(page, "manager account");

    for (const [path, heading, name] of [
      ["/management", /^Controle operacional\.$/, "management overview"],
      ["/management?view=requests", /^Solicitações\.$/, "management requests"],
      ["/management?view=pending", /^Pendências\.$/, "management pending"],
      ["/management?view=stats", /^Estatísticas\.$/, "management statistics"]
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      await expectNoAxeViolations(page, name);
    }

    await signOut(page);
    await signInAs(page, "admin@cvg.local", /Administração técnica/);

    await page.goto("/account");
    await expect(page.getByRole("heading", { name: /Minha conta/ })).toBeVisible();
    await expectNoAxeViolations(page, "admin account");

    for (const [path, heading, name] of [
      ["/admin#users", /^Administração$/, "administration users"],
      ["/admin#catalog", /Serviços diagnósticos/, "administration catalog"],
      ["/admin#reasons", /^Motivos$/, "administration reasons"],
      ["/system#audit", /Auditoria recente/, "administration audit"]
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      await expectNoAxeViolations(page, name);
    }
  });

  test("login form has a keyboard-visible first field and named controls", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("E-mail profissional").focus();
    await expect(page.getByLabel("E-mail profissional")).toBeFocused();
    await expect(page.getByLabel("Senha")).toHaveAttribute("autocomplete", "current-password");
    await expect(page.getByRole("button", { name: "Entrar no Hub" })).toBeVisible();
  });

  test("mobile navigation exposes one current page and 44px keyboard targets", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await page.goto("/patients", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".app-topbar")).toBeVisible();

    const navigation = page.getByRole("navigation", { name: "Navegação rápida" });
    await expect(navigation).toBeVisible();
    await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
    const patientsLink = navigation.getByRole("link", { name: "Acesso rápido: Pacientes" });
    await expect(patientsLink).toHaveAttribute("aria-current", "page");
    const targetHeights = await navigation.locator("a").evaluateAll((links) => links.map((link) => link.getBoundingClientRect().height));
    expect(targetHeights.length).toBeGreaterThan(0);
    expect(Math.min(...targetHeights), "alvo de navegação móvel abaixo de 44px").toBeGreaterThanOrEqual(44);

    await patientsLink.focus();
    await expect(patientsLink).toBeFocused();
    await expect.poll(async () => patientsLink.evaluate((element) => {
      const style = getComputedStyle(element);
      return `${style.outlineWidth} ${style.outlineStyle}`;
    })).toBe("3px solid");
    await expectNoAxeViolations(page, "mobile patients");
  });
});
