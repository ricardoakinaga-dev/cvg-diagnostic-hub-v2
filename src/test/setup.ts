import { afterEach } from "vitest";

// Unit tests own their database opt-ins; a shell configured for the separate
// PostgreSQL integration suite must not authorize a unit test implicitly.
delete process.env.ALLOW_POSTGRES_INTEGRATION_TESTS;
delete process.env.POSTGRES_TEST_ADMIN_URL;

afterEach(() => {
  // Each test owns its fixtures; this hook is intentionally kept for future DOM cleanup.
});
import "@testing-library/jest-dom/vitest";
