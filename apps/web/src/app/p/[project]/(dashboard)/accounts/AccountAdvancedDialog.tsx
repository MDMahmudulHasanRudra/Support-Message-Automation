"use client";

import { useEffect, useState, useTransition } from "react";
import { Dialog, Field, Input, Textarea, Button, Alert, useToast } from "@/components/ui";
import {
  requestCreateGroup,
  requestJoinGroup,
  requestUpdateProfile,
  saveAccountProxy,
  readCreateGroupResult,
  readJoinGroupResult,
  readUpdateProfileResult,
  type AccountCommandStatus,
} from "@/server/actions/accounts";

/**
 * Four account-scoped actions that all share one shape: type something in, queue a live-browser
 * command, watch it settle. Kept in one dialog behind tabs rather than four separate dialogs —
 * these are the "advanced, occasional" actions for an account, unlike Reconnect/Resync/Logout,
 * which stay as their own top-level buttons because they are reached far more often.
 *
 * Each of Create Group / Join Group / Update Profile polls its own most-recent WorkerCommand for
 * this account every two seconds while the dialog is open and something is in flight — the same
 * "queue it, then check back" shape `readGroupParticipants` already established for the Team
 * Members "add from a group" flow.
 */

type Tab = "profile" | "proxy" | "createGroup" | "joinGroup";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "profile", label: "Profile" },
  { id: "proxy", label: "Proxy" },
  { id: "createGroup", label: "Create group" },
  { id: "joinGroup", label: "Join group" },
];

function useCommandPoll(
  accountId: string,
  active: boolean,
  read: (accountId: string) => Promise<AccountCommandStatus>,
): AccountCommandStatus {
  const [status, setStatus] = useState<AccountCommandStatus>({ status: "IDLE" });

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const poll = async () => {
      const next = await read(accountId);
      if (!cancelled) setStatus(next);
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // `read` is one of the four stable server-action imports above, never a fresh closure per
    // render — omitting it from the dependency array is deliberate, not an oversight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, active]);

  return status;
}

function StatusLine({ status }: { status: AccountCommandStatus }) {
  if (status.status === "IDLE") return null;
  if (status.status === "PENDING") {
    return <p className="text-xs text-[color:var(--color-muted-foreground)]">Waiting for the worker…</p>;
  }
  if (status.status === "FAILED") return <Alert tone="danger">{status.error}</Alert>;
  return <Alert tone="success">Done.</Alert>;
}

export function AccountAdvancedDialog({
  open,
  onClose,
  accountId,
  accountLabel,
  proxyAddress,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
  accountLabel: string;
  proxyAddress: string | null;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={`${accountLabel} — advanced`} size="lg">
      {/*
       * Keyed by the open/closed transition rather than reset in an effect — the same pattern the
       * chat inbox's ThreadScroller uses. Every field, tab and in-flight flag here should start
       * fresh each time the dialog is opened, and remounting via `key` IS that reset: there is no
       * state to synchronise back into, only a fresh form to render, which is exactly the case the
       * lint rule against setState-in-an-effect exists to steer away from an effect.
       */}
      <AccountAdvancedDialogBody key={String(open)} accountId={accountId} proxyAddress={proxyAddress} />
    </Dialog>
  );
}

function AccountAdvancedDialogBody({ accountId, proxyAddress }: { accountId: string; proxyAddress: string | null }) {
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>("profile");
  const [pending, startTransition] = useTransition();

  const [profileInFlight, setProfileInFlight] = useState(false);
  const [groupInFlight, setGroupInFlight] = useState(false);
  const [joinInFlight, setJoinInFlight] = useState(false);

  const profileStatus = useCommandPoll(accountId, profileInFlight, readUpdateProfileResult);
  const groupStatus = useCommandPoll(accountId, groupInFlight, readCreateGroupResult);
  const joinStatus = useCommandPoll(accountId, joinInFlight, readJoinGroupResult);

  const [displayName, setDisplayName] = useState("");
  const [about, setAbout] = useState("");
  const [groupName, setGroupName] = useState("");
  const [contactNumbers, setContactNumbers] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [proxyForm, setProxyForm] = useState({ address: "", protocol: "", username: "", password: "" });
  const [proxyError, setProxyError] = useState<string | null>(null);

  return (
    <>
      <div
        role="tablist"
        aria-label="Advanced account actions"
        className="mb-4 flex gap-1 rounded-[var(--radius-md)] bg-[var(--color-surface-subtle)] p-1"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded-[var(--radius-sm)] px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === t.id
                ? "bg-[var(--color-surface)] text-[color:var(--color-foreground)] shadow-sm"
                : "text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "profile" ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const result = await requestUpdateProfile(accountId, {
                displayName: displayName || undefined,
                about: about || undefined,
              });
              if (result.error) showToast({ tone: "danger", title: result.error });
              else {
                setProfileInFlight(true);
                showToast({ tone: "info", title: "Profile update queued" });
              }
            });
          }}
        >
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            Changes WhatsApp&apos;s own profile for this account — not this dashboard. Leave a field
            blank to leave it unchanged.
          </p>
          <Field label="Display name">
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Leave blank to keep the current name" />
          </Field>
          <Field label="About">
            <Textarea value={about} onChange={(e) => setAbout(e.target.value)} rows={2} placeholder="Leave blank to keep the current About text" />
          </Field>
          <StatusLine status={profileStatus} />
          <Button type="submit" loading={pending}>
            Save profile
          </Button>
        </form>
      ) : null}

      {tab === "proxy" ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setProxyError(null);
            startTransition(async () => {
              const result = await saveAccountProxy(accountId, proxyForm);
              if (result.error) setProxyError(result.error);
              else showToast({ tone: "info", title: "Proxy saved — reconnecting to apply it" });
            });
          }}
        >
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            Routes this account&apos;s WhatsApp session through a proxy. Saving queues a reconnect —
            the change takes effect on the next connection, never mid-session. Leave the address
            blank and save to remove the proxy entirely.
          </p>
          {proxyAddress ? (
            <p className="text-xs text-[color:var(--color-muted-foreground)]">
              Currently configured: <span className="font-[family-name:var(--font-mono)]">{proxyAddress}</span>
            </p>
          ) : null}
          <Field label="Proxy address" hint="host:port, e.g. 127.0.0.1:5005">
            <Input
              value={proxyForm.address}
              onChange={(e) => setProxyForm((f) => ({ ...f, address: e.target.value }))}
              placeholder={proxyAddress ?? "127.0.0.1:5005"}
            />
          </Field>
          <Field label="Protocol" hint="Optional — inferred from the address when left blank">
            <Input
              value={proxyForm.protocol}
              onChange={(e) => setProxyForm((f) => ({ ...f, protocol: e.target.value }))}
              placeholder="http, https, socks4 or socks5"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username" hint="Optional">
              <Input value={proxyForm.username} onChange={(e) => setProxyForm((f) => ({ ...f, username: e.target.value }))} />
            </Field>
            <Field label="Password" hint="Leave blank to keep the saved one">
              <Input
                type="password"
                value={proxyForm.password}
                onChange={(e) => setProxyForm((f) => ({ ...f, password: e.target.value }))}
              />
            </Field>
          </div>
          {proxyError ? <Alert tone="danger">{proxyError}</Alert> : null}
          <Button type="submit" loading={pending}>
            Save proxy
          </Button>
        </form>
      ) : null}

      {tab === "createGroup" ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const result = await requestCreateGroup(accountId, groupName, contactNumbers);
              if (result.error) showToast({ tone: "danger", title: result.error });
              else {
                setGroupInFlight(true);
                showToast({ tone: "info", title: "Group creation queued" });
              }
            });
          }}
        >
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            Creates a new WhatsApp group from this account. The group appears on the Groups page,
            unmonitored, after the next sync — nothing here turns automation on for it.
          </p>
          <Field label="Group name">
            <Input value={groupName} onChange={(e) => setGroupName(e.target.value)} required />
          </Field>
          <Field label="Members" hint="One phone number per line or comma-separated">
            <Textarea
              value={contactNumbers}
              onChange={(e) => setContactNumbers(e.target.value)}
              rows={3}
              placeholder={"+8801711111111\n+8801722222222"}
              required
            />
          </Field>
          <StatusLine status={groupStatus} />
          <Button type="submit" loading={pending}>
            Create group
          </Button>
        </form>
      ) : null}

      {tab === "joinGroup" ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const result = await requestJoinGroup(accountId, inviteLink);
              if (result.error) showToast({ tone: "danger", title: result.error });
              else {
                setJoinInFlight(true);
                showToast({ tone: "info", title: "Join request queued" });
              }
            });
          }}
        >
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            Joins a group this account was invited to. The group appears on the Groups page,
            unmonitored, after the next sync.
          </p>
          <Field label="Invite link">
            <Input
              value={inviteLink}
              onChange={(e) => setInviteLink(e.target.value)}
              placeholder="https://chat.whatsapp.com/..."
              required
            />
          </Field>
          <StatusLine status={joinStatus} />
          <Button type="submit" loading={pending}>
            Join group
          </Button>
        </form>
      ) : null}
    </>
  );
}
