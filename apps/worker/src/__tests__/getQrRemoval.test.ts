import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WORKER_COMMAND_TYPE } from "@support-automation/shared";

/**
 * `GET_QR` is gone, and the QR lifecycle it was mistaken for is untouched.
 *
 * The command was born dead: `git log -S` finds no commit in this repository's whole history where
 * `apps/web` contained the string, and none where anything called `enqueueCommand("GET_QR")`. It
 * was added to the enum by the initial schema commit, given a handler in the Phase 5 poller, and
 * never given a caller. Two recovery guards then listed it among the commands that mean "an
 * operator is handling this account", defending against a row that nothing could create.
 *
 * It could never have done the job its name implies, either. `@open-wa/wa-automate` exposes NO
 * on-demand QR call — no `getQr`, no `requestQr`, no `forceRefreshQr`. A QR exists only because
 * `create()` emitted one on `ev.on('qr.**')`, so the only way to obtain a fresh code is to start a
 * connection attempt, which is what RECONNECT does. The handler read a stored column and returned
 * it; the dashboard already reads that same column directly.
 *
 * These assertions are deliberately split in two halves, and the second half is the important one:
 * a removal is only safe if the thing it was confused with still works. Reading the sources is the
 * point rather than a shortcut — this pins the ABSENCE of a call site and the PRESENCE of the real
 * QR path, neither of which any runtime assertion can express, and both of which are exactly what a
 * future change might quietly undo. It needs no database, so it runs anywhere.
 */

const WORKER_SRC = resolve(__dirname, "..");
const REPO_ROOT = resolve(__dirname, "../../../..");

const read = (relativeToWorkerSrc: string) => readFileSync(resolve(WORKER_SRC, relativeToWorkerSrc), "utf8");
const readRepo = (relativeToRepoRoot: string) => readFileSync(resolve(REPO_ROOT, relativeToRepoRoot), "utf8");

/** Comments are not behaviour. Strip them so a doc line naming the removed command cannot pass or
 *  fail these tests for the wrong reason — what matters is whether code still references it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("GET_QR is gone from the command surface", () => {
  it("is not a member of the shared WorkerCommandType catalogue", () => {
    expect(WORKER_COMMAND_TYPE).not.toContain("GET_QR");
  });

  it("is not a member of the Prisma enum", () => {
    const schema = readRepo("packages/db/prisma/schema.prisma");
    const enumBlock = /enum WorkerCommandType \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
    expect(enumBlock).not.toMatch(/^\s*GET_QR\s*$/m);
    // The rest of the enum is untouched — this removal takes one member, not a family.
    expect(enumBlock).toMatch(/^\s*RECONNECT\s*$/m);
    expect(enumBlock).toMatch(/^\s*LOGOUT\s*$/m);
  });

  it("has no handler left in the command processor", () => {
    const source = stripComments(read("commands/commandProcessor.ts"));
    expect(source).not.toContain("GET_QR");
    // The commands that do real work are still dispatched here.
    expect(source).toContain('case "RECONNECT"');
    expect(source).toContain('case "LOGOUT"');
  });
});

describe("the recovery guards no longer depend on it", () => {
  // Both read pending commands to answer "is a person already dealing with this account?". A row
  // type nothing creates was a dead branch in that test; removing it cannot change the answer.
  it("accountRegistrySync's operator check lists only commands that exist", () => {
    const source = stripComments(read("provider/accountRegistrySync.ts"));
    expect(source).not.toContain("GET_QR");
    expect(source).toMatch(/type:\s*\{\s*in:\s*\["RECONNECT",\s*"LOGOUT"\]\s*\}/);
  });

  it("collectionWatchdog's operator check lists only commands that exist", () => {
    const source = stripComments(read("health/collectionWatchdog.ts"));
    expect(source).not.toContain("GET_QR");
    expect(source).toMatch(/type:\s*\{\s*in:\s*\["RECONNECT",\s*"LOGOUT"\]\s*\}/);
  });
});

describe("the real QR lifecycle is untouched", () => {
  // The half of this change that matters. Everything below is what actually produces, stores,
  // clears and displays a QR — none of it went through the removed command.
  it("the provider still receives QR codes on the library's own event", () => {
    const source = read("provider/openwa/OpenWAProvider.ts");
    expect(source).toContain('ev.on("qr.**"');
  });

  it("a connection attempt is still what produces one — RECONNECT still connects", () => {
    const source = stripComments(read("commands/commandProcessor.ts"));
    const reconnect = source.slice(source.indexOf('case "RECONNECT"'));
    // Via connectWithRetry now, which calls provider.connect() and retries an attempt that
    // produced no code at all. The property this guards is that RECONNECT still starts a real
    // connection — not which helper it goes through — so it asserts that rather than the literal
    // call it used to make.
    expect(reconnect).toContain("connectWithRetry(provider, accountId)");
    expect(stripComments(read("provider/connectWithRetry.ts"))).toContain("provider.connect()");
  });

  it("automatic recovery still calls connect() for a dropped session", () => {
    const source = stripComments(read("provider/accountRegistrySync.ts"));
    expect(source).toContain("provider.connect()");
  });

  it("phone/link-code pairing still reaches the library", () => {
    const source = read("provider/openwa/OpenWAProvider.ts");
    expect(source).toContain("linkCode");
    expect(source).toContain("PHONE_CODE");
  });

  it("the account still stores a QR and when it arrived", () => {
    const schema = readRepo("packages/db/prisma/schema.prisma");
    const model = /model WhatsAppAccount \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
    expect(model).toMatch(/\bqrCode\b/);
    expect(model).toMatch(/\bqrUpdatedAt\b/);
    expect(model).toMatch(/\bpairingMethod\b/);
    expect(model).toMatch(/\bpairingPhoneNumber\b/);
  });

  it("boot still clears every stored QR, so a dead code is never shown", () => {
    const source = read("recovery.ts");
    expect(source).toMatch(/qrCode:\s*null/);
  });

  it("the dashboard still reads the QR straight off the account row", () => {
    const page = readRepo("apps/web/src/app/(dashboard)/accounts/page.tsx");
    expect(page).toContain("qrCode: account.qrCode");
    // ...and never by asking the worker for it.
    expect(page).not.toContain("GET_QR");
  });
});
