"use client";

import { useActionState, useMemo, useState, useTransition } from "react";
import Link from "@/components/ProjectLink";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  SectionHeader,
  Select,
  Textarea,
  useToast,
} from "@/components/ui";

/** A group a test message can go to. Keyed on the row id, which is what the action takes. */
export interface TestTarget {
  id: string;
  name: string;
  isMonitored: boolean;
}
import {
  extractPlaceholders,
  renderNotificationTemplate,
  validateTemplateBody,
  type NotificationTemplateDefinition,
} from "@support-automation/shared";
import {
  resetNotificationTemplate,
  sendTemplateTestMessage,
  updateNotificationTemplate,
  type TemplateActionState,
} from "@/server/actions/notificationTemplates";
import type { TemplateLiveness } from "@/server/notificationTemplateStatus";

/**
 * One editable message, with the preview beside it.
 *
 * The preview is the point of the screen. A template is a message with the values missing, and
 * nobody can judge the wording of `Waiting: {{waitingMinutes}} minute(s)` — they can judge
 * "Waiting: 37 minute(s)". It renders through the same function the worker uses, with the sample
 * values declared alongside each variable, so what is shown is what would send.
 */

const initialState: TemplateActionState = {};

export function TemplateCard({
  definition,
  customBody,
  updatedAt,
  updatedBy,
  liveness,
  testGroups,
  testGroupsTruncated = false,
  replyLanguage,
}: {
  definition: NotificationTemplateDefinition;
  /** Null when nobody has edited this one — the built-in wording is in use. */
  customBody: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  liveness: TemplateLiveness;
  /** Groups a test can be sent to. Empty when no account is connected. */
  testGroups: TestTarget[];
  /** True when more reachable groups exist than are listed — said out loud, since a chooser that
   *  stops short otherwise reads as the complete set. */
  testGroupsTruncated?: boolean;
  /** What AI answers customers in, so a customer-facing template can flag a mismatch. */
  replyLanguage: string | null;
}) {
  const [state, formAction, saving] = useActionState(updateNotificationTemplate, initialState);
  const [body, setBody] = useState(customBody ?? definition.defaultBody);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, startReset] = useTransition();
  const [testGroupId, setTestGroupId] = useState<string>("");
  const [testing, startTest] = useTransition();
  const { showToast } = useToast();

  const samples = useMemo(
    () => Object.fromEntries(definition.variables.map((v) => [v.name, v.sample])),
    [definition.variables],
  );
  const preview = useMemo(() => renderNotificationTemplate(body, samples), [body, samples]);
  const validation = useMemo(() => validateTemplateBody(definition.key, body), [definition.key, body]);

  const used = useMemo(() => new Set(extractPlaceholders(body)), [body]);
  const isCustomised = customBody !== null;
  const isDirty = body !== (customBody ?? definition.defaultBody);

  // Only worth raising on the message a customer reads, and only when the two genuinely differ.
  // "Auto" is not a mismatch — it means AI follows whatever the customer wrote, so there is no
  // single language for this to disagree with.
  const languageMismatch =
    definition.audience === "CUSTOMER" &&
    Boolean(replyLanguage) &&
    !/english/i.test(replyLanguage ?? "") &&
    !/^auto/i.test(replyLanguage ?? "");

  const doTestSend = () => {
    startTest(async () => {
      const result = await sendTemplateTestMessage(definition.key, testGroupId);
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      showToast({
        tone: "success",
        title: "Test message queued",
        // Never "sent": it goes through the same queue as everything else, and the delay is
        // normal rather than a fault to go looking for.
        description: "It goes through the send queue, so it usually arrives within a few seconds.",
      });
    });
  };

  const doReset = () => {
    setConfirmReset(false);
    startReset(async () => {
      const result = await resetNotificationTemplate(definition.key);
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      setBody(definition.defaultBody);
      showToast({ tone: "success", title: `${definition.label} restored to the built-in wording` });
    });
  };

  return (
    <Card>
      {/* Badges sit above the header rather than inside its title, which takes a plain string.
          The audience one is worth permanent space: it changes how carefully somebody should edit,
          being the difference between an internal note and the company speaking. */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {definition.audience === "CUSTOMER" ? (
          <Badge color="yellow">Customers read this</Badge>
        ) : (
          <Badge color="gray">Internal alert</Badge>
        )}
        {isCustomised ? <Badge color="blue">Customised</Badge> : null}
      </div>

      <SectionHeader title={definition.label} description={definition.description} />

      {definition.audience === "CUSTOMER" ? (
        <div className="mt-3">
          <Alert tone="warning">
            This goes into the customer&apos;s own conversation, not an internal group. Whatever it
            says is your company speaking.
            {languageMismatch ? (
              <>
                {" "}
                AI answers customers in <strong>{replyLanguage}</strong>, but this message is
                written in English — a customer mid-conversation would see the language change.
                Consider rewriting it to match.
              </>
            ) : null}
          </Alert>
        </div>
      ) : null}

      {!liveness.live ? (
        // Shown rather than blocking the editor: preparing wording for something you are about to
        // switch on is a legitimate thing to be doing. What is not legitimate is letting somebody
        // finish, save, and never find out it cannot send.
        <div className="mt-3">
          <Alert tone="neutral">
            <span className="font-medium">Not sending right now.</span> {liveness.reason}
            {liveness.fixHref ? (
              <>
                {" "}
                <Link className="link" href={liveness.fixHref}>
                  {liveness.fixLabel}
                </Link>
              </>
            ) : null}
          </Alert>
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="key" value={definition.key} />
          <Textarea
            name="body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={Math.max(8, body.split("\n").length + 1)}
            spellCheck
            aria-label={`${definition.label} message`}
          />

          {validation.error ? <Alert tone="danger">{validation.error}</Alert> : null}
          {state.error && !validation.error ? <Alert tone="danger">{state.error}</Alert> : null}
          {state.saved && !isDirty && !state.error ? <Alert tone="success">Saved.</Alert> : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving || Boolean(validation.error) || !isDirty}>
              {saving ? "Saving…" : "Save"}
            </Button>
            {isCustomised ? (
              <Button
                type="button"
                variant="secondary"
                disabled={resetting}
                onClick={() => setConfirmReset(true)}
              >
                {resetting ? "Resetting…" : "Reset to default"}
              </Button>
            ) : null}
            {isDirty ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setBody(customBody ?? definition.defaultBody)}
              >
                Discard changes
              </Button>
            ) : null}
          </div>

          {testGroups.length > 0 ? (
            <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3">
              <p className="mb-2 text-[13px] font-medium text-[color:var(--color-foreground)]">
                Send a test
              </p>
              <p className="mb-2 text-xs text-[color:var(--color-muted-foreground)]">
                Delivers the saved wording with the example values to a real group, clearly labelled
                as a test. The only way to see how WhatsApp actually renders it — and the only way to
                see a real @mention.
              </p>
              <Select value={testGroupId} onChange={(event) => setTestGroupId(event.target.value)}>
                <option value="">Choose a group…</option>
                {testGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                    {group.isMonitored ? " (monitored)" : ""}
                  </option>
                ))}
              </Select>
              {testGroupsTruncated ? (
                <p className="mt-1.5 text-xs text-[color:var(--color-muted-foreground)]">
                  The first {testGroups.length.toLocaleString()} reachable groups, unmonitored ones first.
                  Type in the list to jump to a name.
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!testGroupId || testing || isDirty}
                  onClick={doTestSend}
                >
                  {testing ? "Sending…" : "Send test"}
                </Button>
                {isDirty ? (
                  // It sends what is SAVED, not what is typed. Letting an unsaved edit be tested
                  // would show one message and store another.
                  <span className="text-xs text-[color:var(--color-muted-foreground)]">
                    Save your changes first — the test sends the saved wording.
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          {updatedAt ? (
            <p className="text-xs text-[color:var(--color-muted-foreground)]">
              Edited {updatedAt}
              {updatedBy ? ` by ${updatedBy}` : ""}.
            </p>
          ) : (
            <p className="text-xs text-[color:var(--color-muted-foreground)]">
              Using the built-in wording. Saving an edit here does not affect any other template.
            </p>
          )}
        </form>

        <div className="space-y-3">
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-[color:var(--color-foreground)]">Preview</p>
            {/* Deliberately plain and monospaced rather than styled as a chat bubble: WhatsApp
                renders its own way, and a convincing fake bubble would imply this preview is
                pixel-accurate when only the text is. */}
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)] p-3 font-mono text-[12.5px] leading-relaxed text-[color:var(--color-foreground)]">
              {preview || "(this renders as an empty message)"}
            </pre>
          </div>

          <div>
            <p className="mb-1.5 text-[13px] font-medium text-[color:var(--color-foreground)]">
              Available placeholders
            </p>
            <div className="space-y-1.5">
              {definition.variables.map((variable) => (
                <button
                  key={variable.name}
                  type="button"
                  // Click to insert: these are typed by hand otherwise, and one wrong character is
                  // a placeholder that never fills in.
                  onClick={() => setBody((current) => `${current}{{${variable.name}}}`)}
                  className="flex w-full items-baseline gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-left hover:bg-[color:var(--color-muted)]"
                >
                  <code
                    className={`shrink-0 font-mono text-[12px] ${
                      used.has(variable.name)
                        ? "text-[color:var(--color-foreground)]"
                        : "text-[color:var(--color-muted-foreground)]"
                    }`}
                  >
                    {`{{${variable.name}}}`}
                  </code>
                  <span className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
                    {variable.description}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">
              Any placeholder you leave out is simply not shown. A line containing only a
              placeholder that turns out empty is removed rather than left dangling.
            </p>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={doReset}
        loading={resetting}
        title={`Reset ${definition.label}?`}
        description="Your wording is discarded and the built-in message is used again. Because the default lives in the app rather than a saved copy, this template will also pick up any future improvements to it."
        confirmLabel="Reset to default"
      />
    </Card>
  );
}
