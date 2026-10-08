import { lookup } from "node:dns/promises";
import {
  extractReadableText,
  IMPORT_FETCH_MAX_BYTES,
  IMPORT_FETCH_MAX_REDIRECTS,
  IMPORT_FETCH_TIMEOUT_MS,
  isBlockedImportAddress,
  validateImportUrl,
} from "@support-automation/shared";

/**
 * The impure half of the knowledge base's new import sources: reading a PDF or DOCX upload, and
 * fetching a web page safely. Everything here needs Node APIs or a parsing library, which is
 * exactly why the testable logic it leans on (HTML-to-text, the URL guard, row validation) lives
 * in packages/shared instead — apps/web has no test runner.
 *
 * Every function returns `{ text }` or `{ error }` rather than throwing. An import failure is an
 * operator-facing message on a form, and this repo's standard is that such a message says what to
 * do next, never that it surfaces a library's own exception text.
 */

export type ExtractionResult = { text: string } | { error: string };

/**
 * Below this a "PDF" carried no selectable text at all — almost always a scan or an export of
 * page images, where every character a human sees is a picture of a character.
 */
const MIN_EXTRACTED_PDF_CHARS = 40;

/**
 * Server Actions cap a request body at 8MB (apps/web/next.config.ts). A file near that limit is
 * rejected by Next before this code ever runs, and the operator sees a generic failure, so the
 * form checks against this smaller number first and can explain what actually happened.
 */
export const MAX_KNOWLEDGE_UPLOAD_BYTES = 6 * 1024 * 1024;

export function uploadTooLargeMessage(fileName: string, size: number): string {
  return `${fileName} is ${(size / (1024 * 1024)).toFixed(1)}MB, over the ${MAX_KNOWLEDGE_UPLOAD_BYTES / (1024 * 1024)}MB upload limit. Split the document — one module per import produces better entries anyway — or paste the section you need.`;
}

/**
 * Pulls the selectable text out of a PDF.
 *
 * Two failures are worth naming separately, because the fix differs: an encrypted file needs the
 * password removed, and a scanned file needs OCR. Queueing either would burn API calls on an
 * import that could only ever produce nothing.
 */
export async function extractPdfText(bytes: Uint8Array, fileName: string): Promise<ExtractionResult> {
  // Imported on demand: pdf-parse pulls in the whole of pdfjs, which no other page needs.
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: bytes });

  try {
    const { text } = await parser.getText();
    const trimmed = text.trim();
    if (trimmed.length < MIN_EXTRACTED_PDF_CHARS) {
      return {
        error: `${fileName} has no text that can be read — it looks like a scan or an export of page images. Run it through OCR first, or copy the text out and paste it.`,
      };
    }
    return { text: trimmed };
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === "PasswordException") {
      return {
        error: `${fileName} is password-protected. Open it, save an unprotected copy, and upload that instead.`,
      };
    }
    if (name === "InvalidPDFException" || name === "FormatError") {
      return { error: `${fileName} could not be read as a PDF — the file may be damaged or incomplete.` };
    }
    return { error: `${fileName} could not be read. Try re-exporting it, or paste the text directly.` };
  } finally {
    // pdfjs holds a worker and page buffers open until the document is destroyed.
    await parser.destroy().catch(() => undefined);
  }
}

/** Word documents, via mammoth's raw-text extraction — the styling is irrelevant to a knowledge entry. */
export async function extractDocxText(bytes: Uint8Array, fileName: string): Promise<ExtractionResult> {
  try {
    const mammoth = (await import("mammoth")).default;
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const trimmed = value.trim();
    if (!trimmed) {
      return { error: `${fileName} contains no text — if the content is images, copy the text out and paste it instead.` };
    }
    return { text: trimmed };
  } catch {
    return {
      error: `${fileName} could not be read as a Word document. Only .docx is supported — an older .doc has to be saved as .docx first.`,
    };
  }
}

/**
 * Rejects a host name that resolves anywhere private.
 *
 * The literal check in validateImportUrl() is not enough on its own: a perfectly ordinary public
 * name can have an A record pointing at 127.0.0.1 or at the Docker network this container sits
 * on, and that is the classic way an SSRF filter gets walked past.
 *
 * A gap remains between this check and the connection the fetch below actually makes — closing it
 * completely would mean supplying a custom undici dispatcher with its own lookup hook. Blocking
 * every resolved address, re-running on every redirect hop, and refusing anything unparseable
 * raises the bar far past opportunistic abuse, which is the realistic threat for a form only an
 * authenticated admin can reach.
 */
async function assertPublicHost(hostname: string): Promise<string | null> {
  const bare = hostname.replace(/^\[/, "").replace(/\]$/, "");
  // An address written as a literal never goes near the resolver; it was already judged directly.
  if (isBlockedImportAddress(bare)) {
    return "That address points at a private or internal network, which cannot be imported from.";
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(bare, { all: true });
  } catch {
    return `${hostname} could not be found. Check the address, and that the page is reachable from this server.`;
  }

  if (addresses.length === 0 || addresses.some((entry) => isBlockedImportAddress(entry.address))) {
    return "That address resolves to a private or internal network, which cannot be imported from.";
  }
  return null;
}

export interface FetchedPage {
  text: string;
  /** Where the content actually came from after redirects — this is what gets stored as sourceUrl. */
  finalUrl: string;
}

/** Only formats that carry readable prose. A PDF link is a download, not a page, and is refused. */
const READABLE_CONTENT_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|text\/markdown)/i;

/** Reads at most IMPORT_FETCH_MAX_BYTES, so a stream with no end cannot exhaust this process. */
async function readCappedText(response: Response): Promise<string | null> {
  const body = response.body;
  if (!body) return null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > IMPORT_FETCH_MAX_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(joined);
}

/**
 * Fetches one public web page and returns the readable text on it.
 *
 * Redirects are followed manually rather than by `fetch` itself, because every hop is a fresh
 * chance to be pointed at something internal — a permissive open redirect on a public site is
 * enough. Each hop is re-validated and re-resolved from scratch.
 */
export async function fetchImportablePage(rawUrl: string): Promise<FetchedPage | { error: string }> {
  const initial = validateImportUrl(rawUrl);
  if (!initial.ok) return { error: initial.error };

  let current = initial.url;

  for (let hop = 0; hop <= IMPORT_FETCH_MAX_REDIRECTS; hop += 1) {
    const checked = validateImportUrl(current);
    if (!checked.ok) return { error: checked.error };

    const hostError = await assertPublicHost(new URL(checked.url).hostname);
    if (hostError) return { error: hostError };

    let response: Response;
    try {
      response = await fetch(checked.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(IMPORT_FETCH_TIMEOUT_MS),
        headers: {
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
          "User-Agent": "SupportAutomation-KnowledgeImport/1.0",
        },
      });
    } catch (err) {
      const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
      return {
        error: timedOut
          ? `${checked.url} did not respond within ${IMPORT_FETCH_TIMEOUT_MS / 1000} seconds. Try again, or paste the page's text instead.`
          : `${checked.url} could not be reached. Check the address and that the page is publicly accessible.`,
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { error: "That page redirected somewhere this import could not follow." };
      try {
        current = new URL(location, checked.url).toString();
      } catch {
        return { error: "That page redirected to an address this import could not read." };
      }
      continue;
    }

    if (!response.ok) {
      return {
        error:
          response.status === 401 || response.status === 403
            ? "That page requires a sign-in, which this import cannot do. Copy the text out and paste it instead."
            : `That page returned HTTP ${response.status}. Check the address, or paste the text instead.`,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!READABLE_CONTENT_TYPES.test(contentType)) {
      return {
        error: `That address returned ${contentType.split(";")[0] || "an unknown file type"}, not a web page. Upload the file directly if it is a PDF or Word document.`,
      };
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > IMPORT_FETCH_MAX_BYTES) {
      return { error: "That page is too large to import. Link to a specific section instead of the whole manual." };
    }

    const body = await readCappedText(response);
    if (body === null) {
      return { error: "That page is too large to import. Link to a specific section instead of the whole manual." };
    }

    const isHtml = /html|xml/i.test(contentType);
    const text = (isHtml ? extractReadableText(body) : body).trim();
    if (!text) {
      return {
        error:
          "Nothing readable was found on that page — it probably builds its content in the browser. Open it, copy the text, and paste it instead.",
      };
    }

    return { text, finalUrl: checked.url };
  }

  return { error: `That address redirected more than ${IMPORT_FETCH_MAX_REDIRECTS} times. Use the page's final address instead.` };
}
