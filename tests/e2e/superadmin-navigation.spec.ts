import { expect, test, type Page } from "@playwright/test";
import { signInAs } from "./support/auth";

async function openNavigation(page: Page) {
  const opener = page.getByRole("button", { name: "Abrir menu", exact: true });
  if (await opener.isVisible()) await opener.click();
  return page.getByRole("navigation", { name: "Navegação principal", exact: true });
}

test("superadmin can navigate operations and administration with distinct access and catalog screens", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signInAs(page, "superadmin@cvg.local");
  const identity = await page.request.get("/api/v1/session/me");
  expect(identity.status()).toBe(200);
  expect((await identity.json()).data.user.role).toBe("SUPERADMIN");

  const navigation = await openNavigation(page);
  for (const label of ["Pacientes", "Todos os exames", "Caixa de entrada", "Painel gerencial", "Indicadores", "Administração", "Acessos", "Catálogos", "Sistema"]) {
    await expect(navigation.getByRole("link", { name: label, exact: true })).toBeVisible();
  }
  await expect(navigation.getByRole("link", { name: "Acessos", exact: true })).toHaveAttribute("href", "/admin/users");
  await expect(navigation.getByRole("link", { name: "Catálogos", exact: true })).toHaveAttribute("href", "/admin/catalog");

  await navigation.getByRole("link", { name: "Acessos", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.getByRole("heading", { name: "Acessos", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("form", { name: "Adicionar colaborador" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Adicionar serviço" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Motivos", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Privacidade (LGPD)", exact: true })).toHaveCount(0);
  await expect((await openNavigation(page)).locator('[aria-current="page"]')).toHaveCount(1);

  const accessNavigation = await openNavigation(page);
  await accessNavigation.getByRole("link", { name: "Catálogos", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/catalog$/);
  await expect(page.getByRole("heading", { name: "Catálogos", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("form", { name: "Adicionar serviço" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Motivos", exact: true })).toBeVisible();
  await expect(page.getByRole("form", { name: "Adicionar colaborador" })).toHaveCount(0);
  await expect((await openNavigation(page)).locator('[aria-current="page"]')).toHaveCount(1);

  for (const path of ["/patients", "/dashboard", "/management/overview", "/queues/LABORATORY/items", "/queues/RADIOLOGY/items", "/queues/ULTRASOUND/items", "/users", "/sessions", "/outbox/dead-letters"]) {
    const response = await page.request.get(`/api/v1${path}`);
    expect(response.status(), path).toBe(200);
  }
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.getByRole("heading", { name: "Acessos", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("form", { name: "Adicionar serviço" })).toHaveCount(0);
  expect(errors).toEqual([]);
});
