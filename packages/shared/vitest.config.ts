import { defineConfig } from "vitest/config";

// The module approval and plan rules stay pinned while they are switched off, so locking again later is one setting.
export default defineConfig({ test: { env: { NEXT_PUBLIC_MODULE_LOCKS: "on" } } });
