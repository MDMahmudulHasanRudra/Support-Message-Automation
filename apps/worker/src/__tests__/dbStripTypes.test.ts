import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The worker image runs packages/db/src/index.ts as raw TypeScript through Node's own type stripping (no tsx, no
 * build). Stripping erases types only: a constructor parameter property, an enum or a namespace is a SyntaxError
 * there, and vitest and tsc both accept them. On 31 Oct 2026 one parameter property stopped the production worker
 * at boot — every WhatsApp number disconnected. This loads the file exactly that way.
 */
const DB_INDEX = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packages", "db", "src", "index.ts");

describe("packages/db loads under Node's type stripping, as the worker runs it", () => {
  it("imports without a syntax Node cannot strip", () => {
    const [major] = process.versions.node.split(".").map(Number);
    if ((major ?? 0) < 22) return; // stripping needs Node 22.6+; the image runs 22
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(DB_INDEX).href)});`],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://x:y@127.0.0.1:1/z" }, timeout: 60_000 },
    );
    expect(result.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError/);
    expect(result.status).toBe(0);
  });
});
