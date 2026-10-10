/** A full commit id: a date tag such as 20261003 is hexadecimal too. */
const REVISION = /^[0-9a-f]{40}$/;

/**
 * The commit the running image was built from (Dockerfile `SOURCE_REVISION`, stamped by the release pipeline or
 * by `SOURCE_REVISION=$(git rev-parse HEAD) docker compose build`). Anything else, including an unstamped build,
 * is "unknown", which an installation check refuses.
 */
export function buildRevision(environment: Partial<NodeJS.ProcessEnv> = process.env): string {
  const value = environment.CVG_BUILD_REVISION?.trim().toLowerCase();
  return value && REVISION.test(value) ? value : "unknown";
}

/** One startup line per process, so the logs tell which commit served each period. */
export function startupEvent(service: "app" | "worker", environment: Partial<NodeJS.ProcessEnv> = process.env): string {
  return JSON.stringify({ event: `${service}.start`, revision: buildRevision(environment) });
}
