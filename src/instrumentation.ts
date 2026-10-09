/**
 * Next.js instrumentation: runs once when the server starts, before any request (node_modules/next/dist/docs/
 * 01-app/02-guides/instrumentation.md). PROD-302: secrets mounted as files (`NAME_FILE`) are read into the
 * environment here, so every later `process.env.NAME` read in the app sees them. The worker, migrate, bootstrap and
 * the other scripts call the same loader at their own start. A refused secret (conflict, unreadable file) throws and
 * the server does not start, which is the intended failure mode.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { loadFileSecrets } = await import("./server/security/file-secrets");
  const { loaded, expanded } = loadFileSecrets();
  if (loaded.length > 0 || expanded.length > 0) {
    // Names only, never values.
    console.log(JSON.stringify({ event: "secrets.loaded", loaded, expanded }));
  }
}
