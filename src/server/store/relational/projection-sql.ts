export function idempotentInsertSql(insertSql: string): string {
  if (/\bON\s+CONFLICT\b/i.test(insertSql)) return insertSql;
  if (!/\s+RETURNING\b/i.test(insertSql)) {
    throw new Error("POSTGRES_RELATIONAL_PROJECTION_SHAPE_INVALID");
  }
  return insertSql.replace(/\s+RETURNING\b/i, " ON CONFLICT (id) DO NOTHING RETURNING");
}

export function replaySql(
  table: string,
  insertSql: string,
  selectedColumns: "id" | "id, version"
): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
    throw new Error("POSTGRES_RELATIONAL_PROJECTION_SHAPE_INVALID");
  }
  const shape = insertSql.match(/^\s*INSERT INTO ([a-z_][a-z0-9_]*)\s*\(([^)]+)\)\s+VALUES\s*\(([^)]+)\)/i);
  if (!shape || shape[1].toLowerCase() !== table.toLowerCase()) {
    throw new Error("POSTGRES_RELATIONAL_PROJECTION_SHAPE_INVALID");
  }
  const columns = shape[2].split(",").map((column) => column.trim());
  const expressions = shape[3].split(",").map((expression) => expression.trim());
  if (
    columns.length === 0
    || columns.length !== expressions.length
    || columns.some((column) => !/^[a-z_][a-z0-9_]*$/i.test(column))
    || expressions.some((expression) => !/^\$\d+(?:::[a-z_][a-z0-9_]*)?$/i.test(expression))
  ) {
    throw new Error("POSTGRES_RELATIONAL_PROJECTION_SHAPE_INVALID");
  }
  const predicates = columns.map((column, index) => `${column} IS NOT DISTINCT FROM ${expressions[index]}`);
  return `SELECT ${selectedColumns} FROM ${table} WHERE ${predicates.join(" AND ")}`;
}
