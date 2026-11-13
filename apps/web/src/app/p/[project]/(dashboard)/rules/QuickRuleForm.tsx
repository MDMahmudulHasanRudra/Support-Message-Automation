"use client";

import { useActionState, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Alert, Button, Card, SwitchField, Textarea } from "@/components/ui";
import type { RuleFormState } from "@/server/actions/rules";
import { RuleForm, type RuleFormDefaults } from "./RuleForm";

type Action = (prevState: RuleFormState, formData: FormData) => Promise<RuleFormState>;

const MAX_NAME_KEYWORD = 40;

/** Splits typed or pasted text on commas and line breaks into trimmed, non-empty pieces. */
function splitKeywords(text: string): string[] {
  return text.split(/[,\n]/).map((k) => k.trim()).filter(Boolean);
}

function addUnique(list: string[], more: string[]): string[] {
  const next = [...list];
  for (const k of more) if (!next.some((x) => x.toLowerCase() === k.toLowerCase())) next.push(k);
  return next;
}

function ruleName(keywords: string[]): string {
  const first = keywords[0] ?? "";
  const short = first.length > MAX_NAME_KEYWORD ? `${first.slice(0, MAX_NAME_KEYWORD).trimEnd()}...` : first;
  return `Reply to "${short}"`;
}

function joinWords(words: string[]): string {
  const quoted = words.map((w) => `"${w}"`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
}

/**
 * The simple way to make an automation: keywords on the left, the reply on the right. It submits
 * the same fields the full form would to the same action, so every check there still applies.
 * "More options" hands what was typed to the full form.
 */
export function QuickRuleForm({ action, canActivate }: { action: Action; canActivate: boolean }) {
  const [state, formAction, pending] = useActionState(action, {});
  const [chips, setChips] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState("");
  const [switchOn, setSwitchOn] = useState(false);
  const [full, setFull] = useState(false);

  // A word still being typed counts, so pressing Create never silently drops it.
  const keywords = addUnique(chips, splitKeywords(draft));
  const ready = keywords.length > 0 && reply.trim().length > 0;
  const activate = canActivate && switchOn;

  function commitDraft() {
    const more = splitKeywords(draft);
    if (more.length > 0) setChips((prev) => addUnique(prev, more));
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitDraft();
    } else if (e.key === "Backspace" && draft === "" && chips.length > 0) {
      setChips((prev) => prev.slice(0, -1));
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    if (/[,\n]/.test(text)) {
      e.preventDefault();
      setChips((prev) => addUnique(prev, splitKeywords(`${draft}${text}`)));
      setDraft("");
    }
  }

  if (full) {
    const defaults: RuleFormDefaults = {
      name: keywords.length > 0 ? ruleName(keywords) : undefined,
      type: "AUTO_REPLY",
      matchType: "KEYWORDS",
      keywords,
      replyMessage: reply,
      actionTypes: ["AUTO_REPLY"],
      senderType: "CLIENT",
      status: activate ? "ACTIVE" : "DRAFT",
    };
    return (
      <div className="space-y-3">
        <RuleForm action={action} defaults={defaults} submitLabel="Create rule" />
        <Button type="button" variant="ghost" onClick={() => setFull(false)}>
          Back to the simple form
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="name" value={keywords.length > 0 ? ruleName(keywords) : ""} />
      <input type="hidden" name="type" value="AUTO_REPLY" />
      <input type="hidden" name="matchType" value="KEYWORDS" />
      <input type="hidden" name="keywords" value={keywords.join(", ")} />
      <input type="hidden" name="senderType" value="CLIENT" />
      <input type="hidden" name="priority" value="0" />
      <input type="hidden" name="status" value={activate ? "ACTIVE" : "DRAFT"} />
      <input type="hidden" name="action_AUTO_REPLY" value="on" />

      <Card>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor="quick-keyword" className="block text-[15px] font-semibold text-[color:var(--color-foreground)]">
              When a customer&apos;s message contains
            </label>
            <div className="mt-3 flex min-h-[2.75rem] flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-2 focus-within:border-[var(--color-accent)]">
              {chips.map((k) => (
                <span
                  key={k}
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--color-primary-soft)] py-0.5 pl-2.5 pr-1 text-sm text-[color:var(--color-foreground)]"
                >
                  <span className="min-w-0 break-words">{k}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${k}`}
                    onClick={() => setChips((prev) => prev.filter((x) => x !== k))}
                    className="flex h-5 w-5 items-center justify-center rounded-full text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-border)]"
                  >
                    <span aria-hidden>×</span>
                  </button>
                </span>
              ))}
              <input
                id="quick-keyword"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onBlur={commitDraft}
                placeholder={chips.length === 0 ? "price, package, offer" : "Add another"}
                className="min-w-[8rem] flex-1 bg-transparent px-1 py-1 text-sm outline-none"
              />
            </div>
            <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">
              Press Enter or comma after each word or phrase. Any one of them triggers the reply.
            </p>
          </div>

          <div className="min-w-0">
            <label htmlFor="quick-reply" className="block text-[15px] font-semibold text-[color:var(--color-foreground)]">
              Reply with
            </label>
            <Textarea
              id="quick-reply"
              name="replyMessage"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={5}
              placeholder="Type the message the customer should get"
              className="mt-3"
            />
          </div>
        </div>
      </Card>

      {ready ? (
        <Card>
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            When a customer writes {joinWords(keywords)}, they get:
          </p>
          <div className="mt-3 max-w-md whitespace-pre-wrap break-words rounded-[var(--radius-lg)] rounded-tl-sm bg-[var(--color-primary-soft)] px-3.5 py-2.5 text-sm text-[color:var(--color-foreground)]">
            {reply.trim()}
          </div>
        </Card>
      ) : null}

      {canActivate ? (
        <SwitchField
          label="Switch it on now"
          description="Off saves it as a draft. You can switch it on later from the rules list."
          checked={switchOn}
          onChange={(e) => setSwitchOn(e.target.checked)}
        />
      ) : (
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          This will be saved as a draft. Someone with permission to switch rules on can do that later.
        </p>
      )}

      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending} disabled={!ready}>
          Create rule
        </Button>
        <Button type="button" variant="ghost" onClick={() => setFull(true)}>
          More options: conditions, timing, other actions
        </Button>
      </div>
    </form>
  );
}
