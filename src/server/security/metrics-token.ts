import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Static bearer token for Prometheus (PROD-511). Accepted only by GET /metrics,
 * never as a session: a scraper reads aggregate counters, not clinical data.
 * Digests make the comparison constant-time regardless of the presented length.
 */
export const METRICS_SCRAPE_TOKEN_MIN_LENGTH = 32;

export function assertMetricsTokenConfiguration(environment: Partial<NodeJS.ProcessEnv> = process.env): void {
  const configured = environment.METRICS_SCRAPE_TOKEN;
  if (configured === undefined || configured === "") return;
  if (configured.trim().length < METRICS_SCRAPE_TOKEN_MIN_LENGTH) {
    throw new Error(`METRICS_SCRAPE_TOKEN deve conter ao menos ${METRICS_SCRAPE_TOKEN_MIN_LENGTH} caracteres quando configurado.`);
  }
}

export function metricsScrapeAuthorized(request: Request, environment: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  const configured = environment.METRICS_SCRAPE_TOKEN?.trim();
  if (!configured || configured.length < METRICS_SCRAPE_TOKEN_MIN_LENGTH) return false;
  const match = /^Bearer[ ]+(\S+)$/.exec(request.headers.get("authorization") ?? "");
  if (!match) return false;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(match[1]), digest(configured));
}
