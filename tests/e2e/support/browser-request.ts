import type { APIResponse, Page } from "@playwright/test";

/** One authenticated browser GET; transport failures propagate without a retry. */
export async function browserGet(page: Page, path: string): Promise<Pick<APIResponse, "status" | "json">> {
  const result = await page.evaluate(async (requestedPath) => {
    const target = new URL(requestedPath, window.location.origin);
    if (target.origin !== window.location.origin || !target.pathname.startsWith("/api/v1/")) {
      throw new Error("Browser test reads must target the current origin API.");
    }
    const response = await fetch(target.href, { method: "GET", credentials: "same-origin", cache: "no-store" });
    const body: unknown = await response.json();
    return { status: response.status, body };
  }, path);
  return { status: () => result.status, json: async () => result.body };
}
