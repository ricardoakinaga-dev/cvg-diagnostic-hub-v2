import { describe, expect, it } from "vitest";
import { idempotentInsertSql, replaySql } from "./projection-sql";

describe("relational projection SQL guards", () => {
  it("adds an idempotent conflict clause only to a returning insert", () => {
    const insert = "INSERT INTO diagnostic_requests (id, version) VALUES ($1, $2) RETURNING id, version";
    expect(idempotentInsertSql(insert)).toBe(
      "INSERT INTO diagnostic_requests (id, version) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id, version",
    );
    const existing = `${insert} ON CONFLICT (id) DO NOTHING RETURNING id, version`;
    expect(idempotentInsertSql(existing)).toBe(existing);
    expect(() => idempotentInsertSql("INSERT INTO diagnostic_requests (id) VALUES ($1)")).toThrow(
      "POSTGRES_RELATIONAL_PROJECTION_SHAPE_INVALID",
    );
  });

  it("builds replay predicates that preserve null semantics", () => {
    expect(replaySql(
      "diagnostic_requests",
      "INSERT INTO diagnostic_requests (id, version) VALUES ($1, $2) RETURNING id, version",
      "id, version",
    )).toBe(
      "SELECT id, version FROM diagnostic_requests WHERE id IS NOT DISTINCT FROM $1 AND version IS NOT DISTINCT FROM $2",
    );
  });

  it("rejects unsafe table names and malformed insert shapes", () => {
    const valid = "INSERT INTO diagnostic_requests (id) VALUES ($1) RETURNING id";
    expect(() => replaySql("diagnostic_requests;DROP", valid, "id")).toThrow(
      "POSTGRES_RELATIONAL_PROJECTION_SHAPE_INVALID",
    );
    expect(() => replaySql("other_table", valid, "id")).toThrow(
      "POSTGRES_RELATIONAL_PROJECTION_SHAPE_INVALID",
    );
    expect(() => replaySql(
      "diagnostic_requests",
      "INSERT INTO diagnostic_requests (id, broken column) VALUES ($1, $2) RETURNING id",
      "id",
    )).toThrow("POSTGRES_RELATIONAL_PROJECTION_SHAPE_INVALID");
    expect(() => replaySql(
      "diagnostic_requests",
      "INSERT INTO diagnostic_requests (id) VALUES (current_user) RETURNING id",
      "id",
    )).toThrow("POSTGRES_RELATIONAL_PROJECTION_SHAPE_INVALID");
  });
});
