"use client";

import { useMemo, useState, type ReactNode } from "react";
import { formatMessageBody, type FormatToken } from "@support-automation/shared";

/**
 * A message body, rendered from tokens (packages/shared chatMessageFormat.ts) into React elements —
 * never HTML. Text a customer typed can therefore never become markup, a script or a `javascript:`
 * link: the only links are http(s) ones the tokenizer built, opened in a new tab without access to
 * this page (`noopener noreferrer`).
 *
 * `dir="auto"` lets a Bangla or Arabic message lay itself out the way it was written. A very long
 * message is folded after about fourteen lines with "Read more", so one pasted log does not push the
 * rest of the conversation off the screen.
 */

const FOLD_CHARS = 1100;
const FOLD_LINES = 14;

function render(tokens: readonly FormatToken[], mentionNames: Record<string, string>, onDark: boolean, keyPrefix = ""): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}${index}`;
    switch (token.type) {
      case "text":
        return token.text;
      case "bold":
        return <strong key={key}>{render(token.children, mentionNames, onDark, `${key}.`)}</strong>;
      case "italic":
        return <em key={key}>{render(token.children, mentionNames, onDark, `${key}.`)}</em>;
      case "strike":
        return <s key={key}>{render(token.children, mentionNames, onDark, `${key}.`)}</s>;
      case "code":
        return (
          <code key={key} className="rounded-[var(--radius-xs)] bg-[color-mix(in_oklab,currentColor_10%,transparent)] px-1 font-mono text-[0.92em]">
            {token.text}
          </code>
        );
      case "codeBlock":
        return (
          <pre key={key} className="my-1 overflow-x-auto rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,currentColor_10%,transparent)] px-2 py-1.5 font-mono text-[0.92em] whitespace-pre-wrap">
            {token.text}
          </pre>
        );
      case "link":
        return (
          <a
            key={key}
            href={token.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            onClick={(e) => e.stopPropagation()}
            className={`break-all underline underline-offset-2 ${onDark ? "decoration-current/60" : "text-[color:var(--color-accent)]"}`}
          >
            {token.text}
          </a>
        );
      case "mention": {
        // A name only when the roster resolved these digits; otherwise the text exactly as WhatsApp
        // delivered it — never re-presented as a phone number, because the digits may be a private id.
        const name = mentionNames[token.digits];
        return (
          <span key={key} className={`font-medium ${onDark ? "" : "text-[color:var(--color-accent)]"}`} title={name ? undefined : "Mentioned participant"}>
            <bdi>{name ? `@${name}` : token.text}</bdi>
          </span>
        );
      }
    }
  });
}

export function FormattedBody({
  body,
  mentionNames,
  onDark = false,
}: {
  body: string;
  mentionNames: Record<string, string>;
  /** True on our own (primary-coloured) bubbles, where accent-coloured links would not read. */
  onDark?: boolean;
}) {
  const tokens = useMemo(() => formatMessageBody(body), [body]);
  const long = body.length > FOLD_CHARS || body.split("\n").length > FOLD_LINES;
  const [open, setOpen] = useState(false);

  return (
    <div dir="auto" className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
      <div className={long && !open ? "line-clamp-[14]" : undefined}>{render(tokens, mentionNames, onDark)}</div>
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-[12px] font-medium underline underline-offset-2 opacity-80 hover:opacity-100"
          aria-expanded={open}
        >
          {open ? "Show less" : "Read more"}
        </button>
      ) : null}
    </div>
  );
}
