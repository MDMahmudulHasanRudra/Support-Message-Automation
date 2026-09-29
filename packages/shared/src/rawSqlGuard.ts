/**
 * A static check for raw SQL (MULTI_PROJECT_PLAN.md §5): `$queryRaw` / `$executeRaw` bypass the
 * project-scoped Prisma client, so every raw statement that touches a project-owned table must name
 * the project itself. Pure — the apps' tests feed it their own source files.
 */

export interface RawSqlStatement {
  file: string;
  line: number;
  sql: string;
}

const RAW_CALL = /\$(queryRaw|executeRaw)(Unsafe)?\s*(<[^`(]*>)?\s*(`|\()/g;

/** The body of the template literal starting at `start` (just after the opening backtick). */
function readTemplate(source: string, start: number): string {
  let i = start;
  let depth = 0;
  let out = "";
  while (i < source.length) {
    const c = source[i]!;
    if (depth === 0 && c === "`") return out;
    if (c === "\\") {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "$" && source[i + 1] === "{") {
      depth += 1;
      out += "${";
      i += 2;
      continue;
    }
    if (depth > 0 && c === "}") depth -= 1;
    if (depth > 0 && c === "`") {
      // A nested template (Prisma.sql`...`) inside an interpolation: copy it whole.
      const inner = readTemplate(source, i + 1);
      out += "`" + inner + "`";
      i += inner.length + 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Every tagged-template raw statement in one file. Call-style (`$queryRawUnsafe("…")`) is reported with its first argument. */
export function findRawSqlStatements(file: string, source: string): RawSqlStatement[] {
  const found: RawSqlStatement[] = [];
  for (const match of source.matchAll(RAW_CALL)) {
    const opener = match[4];
    const at = match.index! + match[0].length;
    let sql: string;
    if (opener === "`") sql = readTemplate(source, at);
    else {
      const close = source.indexOf(")", at);
      sql = source.slice(at, close === -1 ? at + 400 : close);
    }
    found.push({ file, line: source.slice(0, match.index).split("\n").length, sql });
  }
  return found;
}

/** Tables a statement reads or writes (`FROM "X"`, `JOIN "X"`, `INTO "X"`, `UPDATE "X"`). */
export function tablesIn(sql: string): string[] {
  return [...sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+"([A-Za-z]+)"/gi)].map((m) => m[1]!);
}

/**
 * The statements that touch a project-owned table without naming `"projectId"` anywhere in them.
 * Deliberately blunt: naming the column is not proof the filter is right (the report tests check
 * that), but NOT naming it is proof the statement reads or writes every project.
 */
export function unscopedRawSql(statements: RawSqlStatement[], scopedTables: ReadonlySet<string>): RawSqlStatement[] {
  return statements.filter((s) => tablesIn(s.sql).some((t) => scopedTables.has(t)) && !s.sql.includes('"projectId"'));
}
