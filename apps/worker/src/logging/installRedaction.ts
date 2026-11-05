// Imported FIRST by index.ts, so the console is redacted before any other module can log (ES modules run
// in import order). See redact.ts; logPrivacy.test.ts checks it stays the first import.
import { installConsoleRedaction } from "./redact.js";

installConsoleRedaction();
