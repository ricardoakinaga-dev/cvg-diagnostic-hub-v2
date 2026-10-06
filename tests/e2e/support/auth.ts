import { expect, type Page } from "@playwright/test";

const password = "e2e-local-password-2026";
const loginEndpoint = "/api/v1/session/login";

/** The Plane-style home greets by time of day, so any greeting proves sign-in. */
export const GREETING = /^(Bom dia|Boa tarde|Boa noite),/;

export async function signInAs(page: Page, email: string, expectedHeading: RegExp = GREETING): Promise<void> {
  // Next renders Client Components before their event handlers are hydrated. The
  // login form is visible in that interval, but a click would submit the native
  // form and return to /login instead of invoking LoginForm.submit.
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("E-mail profissional").fill(email);
  await page.getByLabel("Senha").fill(password);
  const loginResponsePromise = page.waitForResponse(
    (response) => response.url().endsWith(loginEndpoint) && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Entrar no Hub" }).click();
  const loginResponse = await loginResponsePromise;
  expect(loginResponse.ok(), `POST ${loginEndpoint} falhou com ${loginResponse.status()}.`).toBeTruthy();
  await expect(page).toHaveURL(/\/$/, { timeout: 15000 });
  await expect(page.getByRole("heading", { name: expectedHeading })).toBeVisible({ timeout: 15000 });
}

/** Logout lives in the user menu of the top bar, as in Plane. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Menu de / }).click();
  await page.getByRole("menuitem", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
}
