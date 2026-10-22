/**
 * WhatsApp Chat v2 (CHAT_UI_V2.md): turns a stored message body into display tokens.
 *
 * A message body is text a customer typed. It is NEVER treated as HTML: this produces plain tokens and
 * the browser builds React elements from them, so there is no string that could become markup. Links
 * are only ever `http:` / `https:` (a bare `www.` gets `https://`), so a `javascript:` or `data:` URL in a
 * message stays text.
 *
 * WhatsApp's own markers, as its apps read them:
 *   *bold*  _italic_  ~strike~  `inline code`  ```monospace block```
 * A marker opens only at the start, after whitespace or punctuation, with no space after it; it closes
 * before whitespace, punctuation or the end, with no space before it; and never across a line break —
 * so `2*3*4` and `snake_case_name` stay as typed. Inside a URL nothing is formatted (URLs are full of
 * underscores). `@` followed by digits is a mention token; whether those digits are a phone number or a
 * WhatsApp private id (LID) is NOT decided here — the renderer only ever names a mention from a roster
 * it trusts, and otherwise shows the text exactly as typed.
 *
 * Bodies past `FORMAT_LIMIT` characters come back as one text token: formatting a pasted log of tens
 * of thousands of characters is not worth a frozen tab.
 */

export type FormatToken =
  | { type: "text"; text: string }
  | { type: "bold" | "italic" | "strike"; children: FormatToken[] }
  | { type: "code"; text: string }
  | { type: "codeBlock"; text: string }
  | { type: "link"; href: string; text: string }
  | { type: "mention"; digits: string; text: string };

export const FORMAT_LIMIT = 8000;

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const MENTION_RE = /(^|[^\p{L}\p{N}_@])@(\d{5,20})(?!\d)/gu;
const MARKERS: Record<string, "bold" | "italic" | "strike"> = { "*": "bold", _: "italic", "~": "strike" };
/** Punctuation a URL may not END with — it belongs to the sentence around it. */
const TRAILING_PUNCT = /[.,!?;:'")\]}>]+$/;

/** A safe href for a matched URL, or null. */
export function safeLinkHref(raw: string): string | null {
  const candidate = /^www\./i.test(raw) ? `https://${raw}` : raw;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || !url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function formatMessageBody(body: string): FormatToken[] {
  if (!body) return [];
  if (body.length > FORMAT_LIMIT) return [{ type: "text", text: body }];
  const out: FormatToken[] = [];
  // ```blocks``` first: they may span lines and nothing inside them is formatted.
  const blockRe = /```([\s\S]+?)```/g;
  let last = 0;
  for (let m = blockRe.exec(body); m; m = blockRe.exec(body)) {
    if (m.index > last) out.push(...formatInline(body.slice(last, m.index)));
    out.push({ type: "codeBlock", text: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push(...formatInline(body.slice(last)));
  return mergeText(out);
}

/** Inline code, then links and mentions as atoms, then emphasis on what is left. */
function formatInline(text: string): FormatToken[] {
  const out: FormatToken[] = [];
  const codeRe = /`([^`\n]+)`/g;
  let last = 0;
  for (let m = codeRe.exec(text); m; m = codeRe.exec(text)) {
    if (m.index > last) out.push(...linksAndMentions(text.slice(last, m.index)));
    out.push({ type: "code", text: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...linksAndMentions(text.slice(last)));
  return out;
}

function linksAndMentions(text: string): FormatToken[] {
  const out: FormatToken[] = [];
  let last = 0;
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
    let raw = m[0];
    const trailing = TRAILING_PUNCT.exec(raw)?.[0] ?? "";
    if (trailing) raw = raw.slice(0, raw.length - trailing.length);
    const href = safeLinkHref(raw);
    if (!href) continue;
    if (m.index > last) out.push(...mentions(text.slice(last, m.index)));
    out.push({ type: "link", href, text: raw });
    last = m.index + raw.length;
    URL_RE.lastIndex = last;
  }
  if (last < text.length) out.push(...mentions(text.slice(last)));
  return out;
}

function mentions(text: string): FormatToken[] {
  const out: FormatToken[] = [];
  let last = 0;
  MENTION_RE.lastIndex = 0;
  for (let m = MENTION_RE.exec(text); m; m = MENTION_RE.exec(text)) {
    const start = m.index + m[1]!.length;
    if (start > last) out.push(...emphasis(text.slice(last, start)));
    out.push({ type: "mention", digits: m[2]!, text: `@${m[2]}` });
    last = start + 1 + m[2]!.length;
  }
  if (last < text.length) out.push(...emphasis(text.slice(last)));
  return out;
}

const isBoundary = (ch: string | undefined) => ch === undefined || /[\s\p{P}\p{S}]/u.test(ch);

/** Bold / italic / strike, nested, on one stretch of plain text. */
function emphasis(text: string): FormatToken[] {
  for (let i = 0; i < text.length; i++) {
    const kind = MARKERS[text[i]!];
    if (!kind) continue;
    const marker = text[i]!;
    // Opens: boundary before, non-space after.
    if (!isBoundary(text[i - 1]) || text[i + 1] === undefined || /\s/.test(text[i + 1]!) || text[i + 1] === marker) continue;
    // Closes: the first matching marker on the same line with non-space before and a boundary after.
    for (let j = i + 2; j < text.length; j++) {
      if (text[j] === "\n") break;
      if (text[j] !== marker) continue;
      if (/\s/.test(text[j - 1]!) || !isBoundary(text[j + 1])) continue;
      return mergeText([
        ...(i > 0 ? [{ type: "text", text: text.slice(0, i) } as FormatToken] : []),
        { type: kind, children: emphasis(text.slice(i + 1, j)) },
        ...emphasis(text.slice(j + 1)),
      ]);
    }
  }
  return text ? [{ type: "text", text }] : [];
}

function mergeText(tokens: FormatToken[]): FormatToken[] {
  const out: FormatToken[] = [];
  for (const token of tokens) {
    const prev = out[out.length - 1];
    if (token.type === "text" && prev?.type === "text") prev.text += token.text;
    else if (token.type !== "text" || token.text) out.push(token);
  }
  return out;
}

/** The plain text a token list reads as — what "Copy" puts on the clipboard is the body itself, not this. */
export function tokensToPlainText(tokens: readonly FormatToken[]): string {
  return tokens
    .map((t) => ("children" in t ? tokensToPlainText(t.children) : t.text))
    .join("");
}
