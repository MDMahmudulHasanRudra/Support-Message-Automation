"use client";

import { useState, useTransition } from "react";
import { useProjectRouter } from "@/components/ProjectLink";
import { Alert, Button, Input, Select, Textarea } from "@/components/ui";
import { addSocialCommentAction, socialPostAction, socialTargetAction, refreshSocialMetricsAction, rescheduleSocialPostAction, type SocialActionState } from "@/server/actions/social";
import { COMMON_TIME_ZONES } from "../../socialUi";

/** The post's buttons, each shown only when the status allows it AND the person holds its key. */
export function PostActions({
  id,
  status,
  revision,
  can,
  scheduledLocal,
  timezone,
  publishMode,
}: {
  id: string;
  status: string;
  revision: number;
  can: { edit: boolean; approve: boolean; publish: boolean };
  scheduledLocal: string;
  timezone: string;
  publishMode: "SCHEDULE" | "NOW";
}) {
  const router = useProjectRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<SocialActionState>({});
  const [note, setNote] = useState("");
  const [mode, setMode] = useState(publishMode);
  const [when, setWhen] = useState(scheduledLocal);
  const [tz, setTz] = useState(timezone);
  const [repeatEvery, setRepeatEvery] = useState("");
  const [repeatTimes, setRepeatTimes] = useState(3);
  const run = (action: Parameters<typeof socialPostAction>[1], extra: Parameters<typeof socialPostAction>[2] = {}) =>
    start(async () => {
      const r = await socialPostAction(id, action, { revision, ...extra });
      setResult(r);
      if (r.id && action === "DUPLICATE") router.push(`/social/posts/${r.id}`);
      else if (!r.error && action === "DELETE") router.push("/social/posts?view=all");
      else router.refresh();
    });

  const show = {
    submit: can.edit && status === "DRAFT",
    review: can.approve && status === "IN_REVIEW",
    schedule: can.publish && status === "APPROVED",
    reschedule: can.publish && status === "SCHEDULED",
    cancel: can.publish && ["IN_REVIEW", "APPROVED", "SCHEDULED"].includes(status),
    remove: can.edit && ["DRAFT", "CANCELLED", "IN_REVIEW"].includes(status),
    duplicate: can.edit,
  };
  if (!Object.values(show).some(Boolean)) return null;

  return (
    <div className="space-y-3">
      {show.review ? (
        <div className="space-y-2">
          <Textarea aria-label="Note for the writer" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (required to send it back)" />
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={pending} onClick={() => run("APPROVE", { note })}>
              Approve
            </Button>
            <Button loading={pending} onClick={() => run("REJECT", { note })}>
              Send back
            </Button>
          </div>
        </div>
      ) : null}
      {show.schedule || show.reschedule ? (
        <div className="flex flex-wrap items-end gap-2">
          {show.schedule ? (
            <Select aria-label="When" value={mode} onChange={(e) => setMode(e.target.value === "NOW" ? "NOW" : "SCHEDULE")} className="w-40">
              <option value="SCHEDULE">At a set time</option>
              <option value="NOW">Publish now</option>
            </Select>
          ) : null}
          {mode === "SCHEDULE" || show.reschedule ? (
            <>
              <Input type="datetime-local" aria-label="Date and time" value={when} onChange={(e) => setWhen(e.target.value)} className="w-52" />
              <Input aria-label="Time zone" list="post-timezones" value={tz} onChange={(e) => setTz(e.target.value)} className="w-40" />
              <datalist id="post-timezones">
                {COMMON_TIME_ZONES.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </>
          ) : null}
          {show.schedule && mode === "SCHEDULE" ? (
            <>
              <Select aria-label="Repeat" value={repeatEvery} onChange={(e) => setRepeatEvery(e.target.value)} className="w-36">
                <option value="">Once</option>
                <option value="DAY">Repeat daily</option>
                <option value="WEEK">Repeat weekly</option>
                <option value="MONTH">Repeat monthly</option>
              </Select>
              {repeatEvery ? (
                <Select aria-label="How many more times" value={String(repeatTimes)} onChange={(e) => setRepeatTimes(Number(e.target.value))} className="w-28">
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n} more
                    </option>
                  ))}
                </Select>
              ) : null}
            </>
          ) : null}
          {show.schedule ? (
            <Button variant="primary" loading={pending} onClick={() => run("SCHEDULE", { publishMode: mode, scheduledLocal: when, timezone: tz, repeatEvery: repeatEvery || undefined, repeatTimes })}>
              {mode === "NOW" ? "Publish now" : "Schedule"}
            </Button>
          ) : (
            <Button
              loading={pending}
              onClick={() =>
                start(async () => {
                  setResult(await rescheduleSocialPostAction(id, when, tz));
                  router.refresh();
                })
              }
            >
              Move
            </Button>
          )}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {show.submit ? (
          <Button variant="primary" loading={pending} onClick={() => run("SUBMIT")}>
            Send for approval
          </Button>
        ) : null}
        {show.cancel ? (
          <Button variant="danger" loading={pending} onClick={() => (window.confirm("Cancel this post? Accounts that already published are not affected.") ? run("CANCEL") : undefined)}>
            Cancel post
          </Button>
        ) : null}
        {show.duplicate ? (
          <Button loading={pending} onClick={() => run("DUPLICATE")}>
            Duplicate
          </Button>
        ) : null}
        {show.remove ? (
          <Button variant="ghost" loading={pending} onClick={() => (window.confirm("Delete this post?") ? run("DELETE") : undefined)}>
            Delete
          </Button>
        ) : null}
      </div>
      {result.error ? <Alert tone="danger" title={result.error} /> : null}
      {result.success ? <Alert tone="success" title={result.success} /> : null}
    </div>
  );
}

/** One account's publication: the actions its status allows. An unknown outcome needs a person's word. */
export function TargetActions({ targetId, status, canPublish, canDelete, hasMetrics }: { targetId: string; status: string; canPublish: boolean; canDelete: boolean; hasMetrics: boolean }) {
  const router = useProjectRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<SocialActionState>({});
  const [confirmed, setConfirmed] = useState(false);
  const [link, setLink] = useState("");
  const run = (fn: () => Promise<SocialActionState>) =>
    start(async () => {
      setResult(await fn());
      router.refresh();
    });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {canPublish && status === "FAILED" ? (
          <Button size="sm" loading={pending} onClick={() => run(() => socialTargetAction(targetId, "RETRY"))}>
            Retry
          </Button>
        ) : null}
        {canPublish && (status === "DUE" || status === "PENDING") ? (
          <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => socialTargetAction(targetId, "CANCEL"))}>
            Cancel for this account
          </Button>
        ) : null}
        {canPublish && status === "PUBLISHED" && canDelete ? (
          <Button size="sm" variant="danger" loading={pending} onClick={() => (window.confirm("Delete this post from the platform? This cannot be undone.") ? run(() => socialTargetAction(targetId, "DELETE_PUBLICATION")) : undefined)}>
            Delete from platform
          </Button>
        ) : null}
        {status === "PUBLISHED" && hasMetrics ? (
          <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => refreshSocialMetricsAction(targetId))}>
            Refresh statistics
          </Button>
        ) : null}
      </div>
      {canPublish && status === "UNKNOWN" ? (
        <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] p-2 text-xs">
          <p>Check the account. If the post is there, mark it published; if it is not, send it again.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="Link to the post" placeholder="https://… (optional)" value={link} onChange={(e) => setLink(e.target.value)} className="h-8 w-56" />
            <Button size="sm" loading={pending} onClick={() => run(() => socialTargetAction(targetId, "MARK_PUBLISHED", { permalink: link }))}>
              Mark published
            </Button>
            <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => socialTargetAction(targetId, "MARK_FAILED"))}>
              Mark not published
            </Button>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I checked the account and the post is not there
          </label>
          <Button size="sm" variant="danger" disabled={!confirmed} loading={pending} onClick={() => run(() => socialTargetAction(targetId, "SEND_AGAIN", { confirmedNotPublished: confirmed }))}>
            Send again
          </Button>
        </div>
      ) : null}
      {result.error ? <p className="text-xs text-[color:var(--color-danger)]">{result.error}</p> : null}
      {result.success ? <p className="text-xs text-[color:var(--color-success-fg)]">{result.success}</p> : null}
    </div>
  );
}

export function CommentBox({ postId }: { postId: string }) {
  const router = useProjectRouter();
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Textarea aria-label="Comment" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Comment for the team (never published). @username to mention someone." />
      {error ? <p className="text-xs text-[color:var(--color-danger)]">{error}</p> : null}
      <Button
        size="sm"
        loading={pending}
        disabled={!text.trim()}
        onClick={() =>
          start(async () => {
            const r = await addSocialCommentAction(postId, text);
            if (r.error) setError(r.error);
            else {
              setText("");
              setError(null);
              router.refresh();
            }
          })
        }
      >
        Add comment
      </Button>
    </div>
  );
}
