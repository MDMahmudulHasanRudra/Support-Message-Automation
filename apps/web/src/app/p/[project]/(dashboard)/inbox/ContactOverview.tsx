"use client";

import { useEffect, useState } from "react";
import { AtSign, CalendarDays, Check, Copy, Globe, Mail, Phone, ShieldCheck, ShoppingBag, UserRound, Users } from "lucide-react";
import type { ConversationRef } from "@support-automation/shared";
import Link from "@/components/ProjectLink";
import { readConversationContact } from "@/server/actions/inboxWorkspace";
import type { ConversationContact } from "@/server/conversationContact";
import { conversationAvatar } from "../chat/avatar";

const DATE = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric" });
const POSSIBLE = "Possible match: the visitor typed this email, so check who they are before sharing details.";

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[color:var(--color-subtle-foreground)] opacity-0 transition-opacity hover:text-[color:var(--color-foreground)] focus-visible:opacity-100 group-hover/line:opacity-100 max-sm:opacity-100"
    >
      {copied ? <Check className="size-3.5 text-[color:var(--color-success-fg)]" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </button>
  );
}

function Line({ icon: Icon, children, copy }: { icon: typeof Phone; children: React.ReactNode; copy?: { value: string; label: string } }) {
  return (
    <div className="group/line flex min-h-6 items-center gap-2 text-[12.5px] text-[color:var(--color-foreground)]">
      <Icon className="size-3.5 shrink-0 text-[color:var(--color-subtle-foreground)]" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {copy ? <CopyValue {...copy} /> : null}
    </div>
  );
}

/** The top of the Overview: who this is, how to reach them, how much they have talked to us, their records. */
export function ContactOverview({ conversation }: { conversation: ConversationRef }) {
  const key = JSON.stringify(conversation);
  const [state, setState] = useState<{ key: string; contact: ConversationContact | null; error: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    readConversationContact(JSON.parse(key))
      .then((r) => {
        if (!cancelled) setState("error" in r ? { key, contact: null, error: r.error } : { key, contact: r.contact, error: null });
      })
      .catch(() => {
        if (!cancelled) setState({ key, contact: null, error: "Customer details could not be loaded. Close the panel and open it again." });
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (!state || state.key !== key) {
    return (
      <div className="flex items-center gap-3" aria-hidden>
        <span className="size-11 animate-pulse rounded-full bg-[var(--color-neutral-bg)]" />
        <span className="flex-1 space-y-2">
          <span className="block h-3 w-2/3 animate-pulse rounded bg-[var(--color-neutral-bg)]" />
          <span className="block h-2.5 w-1/2 animate-pulse rounded bg-[var(--color-neutral-bg)]" />
        </span>
      </div>
    );
  }
  if (state.error || !state.contact) return <p className="text-[12.5px] text-[color:var(--color-danger-fg)]">{state.error ?? "Customer details could not be found."}</p>;

  const c = state.contact;
  const avatar = conversationAvatar(key, c.name);
  return (
    <div className="space-y-3.5">
      <div className="flex items-center gap-3">
        <span aria-hidden style={{ background: avatar.background, color: avatar.color }} className="flex size-11 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold">
          {c.isGroup ? <Users className="size-5" /> : avatar.initials}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]" dir="auto">
            {c.name}
          </p>
          {c.via ? <p className="truncate text-[12px] text-[color:var(--color-muted-foreground)]">via {c.via}</p> : null}
        </div>
      </div>

      <div className="space-y-0.5">
        {c.phone ? (
          <Line icon={Phone} copy={{ value: `+${c.phone}`, label: "phone number" }}>
            <a href={`tel:+${c.phone}`} className="tabular hover:underline">
              +{c.phone}
            </a>
          </Line>
        ) : null}
        {c.email ? (
          <Line icon={Mail} copy={{ value: c.email, label: "email" }}>
            <a href={`mailto:${c.email}`} className="hover:underline">
              {c.email}
            </a>
          </Line>
        ) : null}
        {c.username ? <Line icon={AtSign}>{c.username}</Line> : null}
        {c.participants !== null ? <Line icon={Users}>{c.participants === 1 ? "1 member" : `${c.participants} members`}</Line> : null}
        {c.pageUrl ? (
          <Line icon={Globe}>
            <a href={c.pageUrl} target="_blank" rel="noopener noreferrer nofollow" title={c.pageUrl} className="hover:underline">
              {c.pageUrl}
            </a>
          </Line>
        ) : null}
        {c.verified === true ? (
          <Line icon={ShieldCheck}>
            <span className="text-[color:var(--color-success-fg)]">Signed in on the website</span>
          </Line>
        ) : c.verified === false ? (
          <Line icon={UserRound}>
            <span className="text-[color:var(--color-muted-foreground)]">Name and email as they typed them</span>
          </Line>
        ) : null}
        {c.firstAt ? <Line icon={CalendarDays}>First message {DATE.format(new Date(c.firstAt))}</Line> : null}
      </div>

      <dl className="grid grid-cols-3 divide-x divide-[var(--color-border)] rounded-[var(--radius-lg)] bg-[var(--color-surface-sunken)] py-2 text-center">
        {[
          { label: "Messages", value: c.stats.messages },
          { label: "From them", value: c.stats.fromCustomer },
          { label: "Resolved", value: c.stats.resolved },
        ].map((s) => (
          <div key={s.label} className="px-1">
            <dd className="tabular text-[14px] font-semibold text-[color:var(--color-foreground)]">{s.value.toLocaleString("en-US")}</dd>
            <dt className="text-[11px] text-[color:var(--color-muted-foreground)]">{s.label}</dt>
          </div>
        ))}
      </dl>

      {c.clients && c.clients.length > 0 ? (
        <section>
          <h3 className="mb-1 text-[12px] font-medium text-[color:var(--color-muted-foreground)]">Client</h3>
          <ul className="space-y-1">
            {c.clients.map((client) => (
              <li key={client.id} className="flex items-center justify-between gap-2 text-[12.5px]">
                <Link href={`/clients/${client.id}`} className="link min-w-0 truncate" dir="auto">
                  {client.name}
                </Link>
                <span className="tabular shrink-0 text-[11px] text-[color:var(--color-subtle-foreground)]" title={client.verified ? undefined : POSSIBLE}>
                  {client.code}
                  {client.verified ? "" : " · possible"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {c.orders && c.orders.length > 0 ? (
        <section>
          <h3 className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-[color:var(--color-muted-foreground)]">
            <ShoppingBag className="size-3.5" aria-hidden />
            Orders
          </h3>
          <ul className="space-y-1">
            {c.orders.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-2 text-[12.5px]">
                <Link href={`/commerce/orders/${o.id}`} className="link tabular min-w-0 truncate" title={o.verified ? undefined : POSSIBLE}>
                  {o.number}
                </Link>
                <span className="shrink-0 text-[11.5px] text-[color:var(--color-muted-foreground)]">
                  {o.status} · <span className="tabular">{o.total}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
