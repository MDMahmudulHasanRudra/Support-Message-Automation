import { describe, expect, it } from "vitest";
import {
  extractReadableText,
  isBlockedImportAddress,
  MAX_KNOWLEDGE_IMPORT_ROWS,
  parseKnowledgeImportRows,
  validateImportUrl,
} from "../knowledgeImportRows.js";

/**
 * Pure unit tests — no database, no network. These three functions live in packages/shared
 * precisely so they can be exercised here: apps/web, where they are used, has no test runner.
 */

describe("parseKnowledgeImportRows", () => {
  it("accepts a minimal question/answer sheet and derives the missing fields", () => {
    const { results, fileErrors } = parseKnowledgeImportRows([
      { Question: "When does billing run?", Answer: "Billing runs on the 1st of each month." },
    ]);

    expect(fileErrors).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("VALID");
    expect(results[0]!.rowNumber).toBe(2); // header is row 1, as the operator sees it in Excel
    expect(results[0]!.row).toMatchObject({
      title: "When does billing run?",
      category: "FAQ",
      question: "When does billing run?",
      answer: "Billing runs on the 1st of each month.",
      module: null,
    });
  });

  it("matches columns regardless of case and surrounding whitespace", () => {
    const { results } = parseKnowledgeImportRows([
      { " QUESTION ": "Q?", answer: "A.", Category: "sop", Module: "Billing", Title: "Given title" },
    ]);

    expect(results[0]!.row).toMatchObject({ title: "Given title", category: "SOP", module: "Billing" });
  });

  it("reports a missing required column once, at file level", () => {
    const { results, fileErrors } = parseKnowledgeImportRows([{ Question: "Q?", Notes: "no answer column" }]);

    expect(results).toEqual([]);
    expect(fileErrors).toHaveLength(1);
    expect(fileErrors[0]).toContain("Answer");
  });

  it("rejects an empty file", () => {
    expect(parseKnowledgeImportRows([]).fileErrors[0]).toContain("no data rows");
  });

  it("refuses a file with more rows than anyone could review", () => {
    const many = Array.from({ length: MAX_KNOWLEDGE_IMPORT_ROWS + 1 }, (_, i) => ({
      Question: `Q${i}`,
      Answer: `A${i}`,
    }));

    const { results, fileErrors } = parseKnowledgeImportRows(many);
    expect(results).toEqual([]);
    expect(fileErrors[0]).toContain(String(MAX_KNOWLEDGE_IMPORT_ROWS));
  });

  it("calls out a blank trailing row as blank rather than as two missing fields", () => {
    const { results } = parseKnowledgeImportRows([
      { Question: "Q?", Answer: "A." },
      { Question: "", Answer: "" },
    ]);

    expect(results[1]!.outcome).toBe("INVALID");
    expect(results[1]!.reason).toContain("Blank row");
  });

  it("flags a row missing only the answer, and keeps the good rows around it valid", () => {
    const { results } = parseKnowledgeImportRows([
      { Question: "Q1?", Answer: "A1." },
      { Question: "Q2?", Answer: "" },
      { Question: "Q3?", Answer: "A3." },
    ]);

    expect(results.map((r) => r.outcome)).toEqual(["VALID", "INVALID", "VALID"]);
    expect(results[1]!.reason).toContain("Answer");
  });

  it("rejects a category that is not one of the real ones", () => {
    const { results } = parseKnowledgeImportRows([{ Question: "Q?", Answer: "A.", Category: "URGENT" }]);

    expect(results[0]!.outcome).toBe("INVALID");
    expect(results[0]!.reason).toContain("URGENT");
  });

  it("marks a repeated title as a duplicate but keeps the first occurrence valid", () => {
    const { results } = parseKnowledgeImportRows([
      { Question: "Q?", Answer: "A.", Title: "Billing dates" },
      { Question: "Q different?", Answer: "A2.", Title: "billing DATES" },
    ]);

    expect(results[0]!.outcome).toBe("VALID");
    expect(results[1]!.outcome).toBe("DUPLICATE_IN_FILE");
  });
});

describe("extractReadableText", () => {
  it("drops script and style content entirely", () => {
    const text = extractReadableText(
      "<html><head><style>body{color:red}</style></head><body><script>alert('x')</script><p>Real content.</p></body></html>",
    );

    expect(text).toContain("Real content.");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
  });

  it("prefers <main> over the surrounding chrome", () => {
    const text = extractReadableText(
      "<body><nav>Home Products Contact</nav><main><p>The billing cycle starts on the 1st.</p></main><footer>Copyright</footer></body>",
    );

    expect(text).toContain("The billing cycle starts on the 1st.");
    expect(text).not.toContain("Home Products Contact");
    expect(text).not.toContain("Copyright");
  });

  it("falls back to <article> when there is no <main>", () => {
    const text = extractReadableText("<body><div>Sidebar junk</div><article><p>Article body.</p></article></body>");

    expect(text).toContain("Article body.");
    expect(text).not.toContain("Sidebar junk");
  });

  it("unescapes entities after tags are gone, so escaped markup stays text", () => {
    const text = extractReadableText("<main><p>Tom &amp; Jerry &lt;script&gt;alert(1)&lt;/script&gt; &#65;&nbsp;end</p></main>");

    expect(text).toContain("Tom & Jerry");
    expect(text).toContain("<script>alert(1)</script>");
    expect(text).toContain("A end");
  });

  it("keeps the page title as the first line", () => {
    const text = extractReadableText("<html><head><title>PPPoE Setup</title></head><body><main><p>Step one.</p></main></body></html>");

    expect(text.startsWith("PPPoE Setup")).toBe(true);
    expect(text).toContain("Step one.");
  });

  it("collapses whitespace and turns block ends into line breaks", () => {
    const text = extractReadableText("<main><p>One</p>\n\n\n<p>Two</p><br><span>Three     four</span></main>");

    expect(text).toMatch(/One\n+Two/);
    expect(text).toContain("Three four");
    expect(text).not.toMatch(/\n{3}/);
  });

  it("returns nothing readable for a page that is only script", () => {
    expect(extractReadableText("<script>var a = 1;</script>")).toBe("");
  });
});

describe("isBlockedImportAddress", () => {
  it("blocks loopback, private, link-local and metadata addresses", () => {
    for (const address of [
      "127.0.0.1",
      "127.1.1.1",
      "0.0.0.0",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isBlockedImportAddress(address), address).toBe(true);
    }
  });

  it("allows an ordinary public address", () => {
    expect(isBlockedImportAddress("93.184.216.34")).toBe(false);
    expect(isBlockedImportAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });

  it("blocks anything it cannot positively identify", () => {
    expect(isBlockedImportAddress("")).toBe(true);
    expect(isBlockedImportAddress("not:an:address:at:all:zz")).toBe(true);
  });
});

describe("validateImportUrl", () => {
  it("accepts a normal https page", () => {
    const result = validateImportUrl("https://docs.example.com/billing/overview");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe("https://docs.example.com/billing/overview");
  });

  it("rejects a non-http scheme", () => {
    const result = validateImportUrl("file:///etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("http");
  });

  it("rejects loopback, private and metadata targets written as literals", () => {
    for (const url of [
      "http://localhost:3000/",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/internal",
      "http://postgres.internal/",
      "http://db.local/",
    ]) {
      const result = validateImportUrl(url);
      expect(result.ok, url).toBe(false);
    }
  });

  it("rejects a decimal-encoded loopback address", () => {
    // http://2130706433/ is 127.0.0.1 written as one number, and Node's resolver honours it.
    expect(validateImportUrl("http://2130706433/").ok).toBe(false);
  });

  it("rejects credentials embedded in the address", () => {
    expect(validateImportUrl("https://user:secret@docs.example.com/").ok).toBe(false);
  });

  it("rejects text that is not a URL at all", () => {
    expect(validateImportUrl("docs.example.com").ok).toBe(false);
    expect(validateImportUrl("   ").ok).toBe(false);
  });
});
