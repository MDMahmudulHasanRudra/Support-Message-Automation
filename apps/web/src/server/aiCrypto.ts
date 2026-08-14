/**
 * Relocated into packages/db/src/index.ts so apps/worker (packages/ai-client's Prisma-only
 * consumer) can use the exact same encrypt/decrypt/mask functions without a second copy — see
 * that file's doc comment for why they had to move rather than live in a new sibling module
 * under packages/db/src. This re-export keeps every existing call site in apps/web unchanged.
 */
export { encryptSecret, decryptSecret, maskSecret } from "@support-automation/db";
