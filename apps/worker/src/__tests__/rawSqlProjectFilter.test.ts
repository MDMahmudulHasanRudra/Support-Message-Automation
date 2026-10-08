import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_SCOPED_MODELS } from "@support-automation/db";
import { findRawSqlStatements, unscopedRawSql } from "@support-automation/shared";

/**
 * Every raw SQL statement in the worker that touches a project-owned table names `"projectId"`.
 * `$queryRaw` is the one thing the scoped client cannot reach (MULTI_PROJECT_PLAN.md §5), so a new
 * report written with raw SQL and no project filter would read every project and pass every other
 * check. This fails the build instead. The report tests prove the existing filters are RIGHT;
 * this proves none is missing.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("raw SQL names its project", () => {
  const statements = sourceFiles(SRC).flatMap((file) => findRawSqlStatements(relative(SRC, file), readFileSync(file, "utf8")));

  it("finds the worker's raw statements", () => {
    expect(statements.length).toBeGreaterThanOrEqual(3);
  });

  it("every statement on a project-owned table filters by project", () => {
    expect(unscopedRawSql(statements, PROJECT_SCOPED_MODELS).map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });

  it("the check itself catches a statement that forgets", () => {
    const bad = findRawSqlStatements("x.ts", 'await prisma.$queryRaw`SELECT count(*) FROM "Message" m WHERE m."groupId" = ${id}`;');
    expect(unscopedRawSql(bad, PROJECT_SCOPED_MODELS)).toHaveLength(1);
    const good = findRawSqlStatements("x.ts", 'await prisma.$queryRaw`SELECT 1 FROM "Message" m WHERE m."projectId" = ${p} ${cond ? Prisma.sql`AND x` : Prisma.empty}`;');
    expect(unscopedRawSql(good, PROJECT_SCOPED_MODELS)).toHaveLength(0);
  });
});
