import { AlertTriangle, Building2, Hash, MessageCircle, Phone, ShieldQuestion, Smartphone, UserRound, Users, X } from "lucide-react";
import Link from "@/components/ProjectLink";
import { Badge } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import type { ContactProfile, GroupPerson, GroupProfile, LiveMember } from "@/server/chatProfiles";
import { PHONE_SOURCE_LABELS } from "@support-automation/shared";
import { conversationAvatar } from "./avatar";
import { AvatarFace } from "./AvatarFace";
import { LinkSenderForm, ReadMembersButton } from "./ChatPanelActions";

/**
 * The contact and group information panels of WhatsApp Chat (WHATSAPP_IDENTITY.md §7).
 *
 * Opened by the URL (`?contact=<id>` / `?info=group`), so they are real links: bookmarkable, the
 * back button closes them, and nothing is client state. Everything shown is what this app stored or
 * what WhatsApp returned when asked; a value we do not have says so. Two distinctions are kept on
 * screen because blurring them is how a wrong answer looks right:
 *  - a phone number is not a WhatsApp private id (LID) — a LID is never printed as a number;
 *  - "people seen in stored messages" is not "the members of this group right now".
 */

function PanelShell({ title, closeHref, children }: { title: string; closeHref: string; children: React.ReactNode }) {
  return (
    <aside
      aria-label={title}
      className="flex w-[23rem] shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] max-lg:absolute max-lg:inset-0 max-lg:z-20 max-lg:w-full max-lg:border-l-0"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <Link
          href={closeHref}
          aria-label={`Close ${title.toLowerCase()}`}
          className="flex size-8 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
        >
          <X className="size-4" aria-hidden />
        </Link>
        <h2 className="text-[13px] font-semibold text-[color:var(--color-foreground)]">{title}</h2>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">{children}</div>
    </aside>
  );
}

function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold tracking-[0.04em] text-[color:var(--color-muted-foreground)] uppercase">{title}</h3>
      {children}
      {note ? <p className="text-[11px] leading-relaxed text-[color:var(--color-subtle-foreground)]">{note}</p> : null}
    </section>
  );
}

function Row({ icon: Icon, label, children }: { icon: typeof Phone; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 text-[12px]">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-[color:var(--color-muted-foreground)]" aria-hidden />
      <div className="min-w-0">
        <div className="text-[11px] text-[color:var(--color-muted-foreground)]">{label}</div>
        <div className="break-words text-[color:var(--color-foreground)]">{children}</div>
      </div>
    </div>
  );
}

const Muted = ({ children }: { children: React.ReactNode }) => <span className="text-[color:var(--color-muted-foreground)]">{children}</span>;

/** How to write an id that is not a dialable number: masked, and never formatted as one. */
const maskedId = (id: string | null) => (id ? `···${id.slice(-4)}` : "unknown");

export function ContactPanel({ profile, accountId, closeHref, picturePath }: { profile: ContactProfile; accountId: string; closeHref: string; picturePath?: string | null }) {
  const member = profile.roster.member;
  const title = member?.name ?? profile.names[0] ?? profile.phone ?? `WhatsApp user ${maskedId(profile.whatsappId)}`;
  const avatar = conversationAvatar(profile.senderId, title);
  const kind = profile.isOurNumber
    ? { text: "Our WhatsApp number", color: "blue" as const }
    : member
      ? { text: "Team member", color: "green" as const }
      : profile.roster.candidates.length
        ? { text: "Team member · needs review", color: "yellow" as const }
        : { text: "External contact", color: "gray" as const };

  return (
    <PanelShell title="Contact info" closeHref={closeHref}>
      <div className="flex flex-col items-center gap-2 text-center">
        <span
          aria-hidden
          style={{ background: avatar.background, color: avatar.color }}
          className="relative flex size-16 items-center justify-center overflow-hidden rounded-full text-[20px] font-semibold"
        >
          <AvatarFace path={picturePath}>{avatar.initials}</AvatarFace>
        </span>
        <div>
          <p className="text-[15px] font-semibold text-[color:var(--color-foreground)]">{title}</p>
          {profile.phone && profile.phone !== title ? <p className="tabular text-[12px] text-[color:var(--color-muted-foreground)]">{profile.phone}</p> : null}
        </div>
        <Badge color={kind.color}>{kind.text}</Badge>
      </div>

      <Section title="WhatsApp">
        <Row icon={Phone} label="Phone number">
          {profile.phoneInfo.state === "KNOWN" ? (
            <>
              <span className="tabular">{profile.phoneInfo.phone}</span>
              <Muted> · {PHONE_SOURCE_LABELS[profile.phoneInfo.source]}</Muted>
            </>
          ) : (
            <>
              Phone number unavailable
              <Muted>
                {" "}
                —{" "}
                {profile.phoneInfo.reason === "HIDDEN_BY_WHATSAPP"
                  ? "this person writes with a private WhatsApp ID, which is not a phone number. Link them to a team member or a client to show a number."
                  : "WhatsApp gave no number for this sender."}
              </Muted>
            </>
          )}
        </Row>
        <Row icon={Hash} label={profile.kind === "LID" ? "Private WhatsApp ID (LID)" : "WhatsApp ID"}>
          <span className="font-mono text-[11px]">{profile.whatsappId ?? "—"}</span>
        </Row>
        {profile.names.length ? (
          <Row icon={UserRound} label="Names used on WhatsApp">
            {profile.names.join(", ")}
          </Row>
        ) : null}
      </Section>

      <Section
        title="Team roster"
        note={
          profile.roster.status === "UNRESOLVED" && !profile.isOurNumber
            ? "Not matched to anybody on Team Members, so their messages count as a customer's. If this is a colleague, link them below."
            : undefined
        }
      >
        <p className="text-[12px] text-[color:var(--color-foreground)]">{profile.roster.statusLabel}.</p>
        {member ? (
          <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
            <Row icon={UserRound} label="Team member">
              {member.name}
              {!member.active ? <Muted> (inactive)</Muted> : null}
            </Row>
            <Row icon={Building2} label="Designation · department · team">
              {[member.designation, member.department, member.teamName].filter(Boolean).join(" · ") || <Muted>Not set</Muted>}
            </Row>
            {profile.canViewRoster ? (
              <Row icon={Phone} label="On their record">
                <span className="tabular">{member.phoneNumber}</span>
                {member.whatsappId ? <span className="block font-mono text-[11px]">WhatsApp ID {member.whatsappId}</span> : null}
              </Row>
            ) : null}
          </div>
        ) : null}
        {profile.roster.candidates.length ? (
          <div className="flex gap-2 rounded-[var(--radius-md)] bg-[var(--color-warning-bg)] p-3 text-[12px] text-[color:var(--color-warning-fg)]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <div>
              <p>
                This id matches {profile.roster.candidates.map((c) => c.name).join(" and ")}, so their messages are counted as a team
                member&apos;s but credited to nobody in reports until the roster is corrected.
              </p>
              {profile.canViewRoster ? (
                <Link href="/team-members" className="link mt-1 inline-block">
                  Open Team Members
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
        {profile.canLink && profile.linkableMembers.length ? <LinkSenderForm senderId={profile.senderId} members={profile.linkableMembers} previewEnabled={profile.canPreviewImpact} /> : null}
        {profile.canLink && !profile.linkableMembers.length && !profile.isOurNumber ? (
          <p className="text-[11px] text-[color:var(--color-muted-foreground)]">
            Every active team member already has a WhatsApp ID. Add this person on Team Members instead.
          </p>
        ) : null}
      </Section>

      <Section title="Activity" note="Counted from messages this app stored; a message two of our numbers both received counts once.">
        <Row icon={MessageCircle} label="Messages">
          <span className="tabular">{profile.messageCount.toLocaleString("en-US")}</span>
        </Row>
        {profile.firstSeenAt && profile.lastSeenAt ? (
          <Row icon={ShieldQuestion} label="First and last seen">
            {formatDateTime(profile.firstSeenAt)} — {formatDateTime(profile.lastSeenAt)}
          </Row>
        ) : null}
      </Section>

      {profile.groups.length || profile.personalChatId ? (
        <Section title="Conversations">
          <ul className="space-y-1">
            {profile.personalChatId ? (
              <li>
                <Link
                  href={`/chat/account/${accountId}/personal/${encodeURIComponent(profile.personalChatId)}`}
                  className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-[12px] hover:bg-[var(--color-neutral-bg)]"
                >
                  <UserRound className="size-3.5 text-[color:var(--color-muted-foreground)]" aria-hidden />
                  Personal chat
                </Link>
              </li>
            ) : null}
            {profile.groups.map((g) => {
              const content = (
                <>
                  <Users className="size-3.5 shrink-0 text-[color:var(--color-muted-foreground)]" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{g.name}</span>
                  <span className="tabular shrink-0 text-[11px] text-[color:var(--color-muted-foreground)]">{g.messages}</span>
                </>
              );
              return (
                <li key={g.whatsappGroupId}>
                  {g.groupId ? (
                    <Link href={`/chat/account/${accountId}/${g.groupId}`} className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-[12px] hover:bg-[var(--color-neutral-bg)]">
                      {content}
                    </Link>
                  ) : (
                    <div className="flex items-center gap-2 px-2 py-1.5 text-[12px]" title="Seen by another of our numbers only">
                      {content}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}

      <p className="text-[11px] leading-relaxed text-[color:var(--color-subtle-foreground)]">
        Profile photos and &ldquo;about&rdquo; text are not collected by this app, so they are not shown.
      </p>
    </PanelShell>
  );
}

function personLabel(p: { memberName: string | null; name: string | null; phone: string | null; senderId?: string; rawId?: string }) {
  return p.memberName ?? p.name ?? p.phone ?? `WhatsApp user ${maskedId((p.senderId ?? p.rawId ?? "").split("@")[0] ?? null)}`;
}

function PersonBadges({ person }: { person: { memberName: string | null; status: string; isOurNumber?: boolean; isSelf?: boolean } }) {
  if (person.isSelf) return <Badge color="blue">This number</Badge>;
  if (person.isOurNumber) return <Badge color="blue">Our number</Badge>;
  if (person.memberName) return <Badge color="green">Team</Badge>;
  if (person.status === "CONFLICT" || person.status === "AMBIGUOUS") return <Badge color="yellow">Team · review</Badge>;
  return null;
}

export function GroupPanel({ profile, contactHref, closeHref, picturePath }: { profile: GroupProfile; contactHref: (key: string) => string; closeHref: string; picturePath?: string | null }) {
  const { group, live } = profile;
  const avatar = conversationAvatar(group.id, group.name);
  return (
    <PanelShell title="Group info" closeHref={closeHref}>
      <div className="flex flex-col items-center gap-2 text-center">
        <span
          aria-hidden
          style={{ background: avatar.background, color: avatar.color }}
          className="relative flex size-16 items-center justify-center overflow-hidden rounded-[var(--radius-xl)] text-[20px] font-semibold"
        >
          <AvatarFace path={picturePath}>{avatar.initials}</AvatarFace>
        </span>
        <p className="text-[15px] font-semibold text-[color:var(--color-foreground)]">{group.name}</p>
        <div className="flex flex-wrap justify-center gap-1.5">
          {group.isActive ? <Badge color="green">Member</Badge> : <Badge color="red">Left the group</Badge>}
          {group.isMonitored ? <Badge color="blue">Monitored</Badge> : <Badge color="gray">Not monitored</Badge>}
          {group.aiAutomationEnabled ? <Badge color="blue">AI on</Badge> : null}
          {group.testModeEnabled ? <Badge color="yellow">Test group</Badge> : null}
        </div>
      </div>

      {group.description ? (
        <Section title="Description" note="As WhatsApp shows it. Updated when the group list is synced.">
          <p className="whitespace-pre-wrap break-words text-[13px] text-[color:var(--color-foreground)]">{group.description}</p>
        </Section>
      ) : null}

      <Section title="Details">
        <Row icon={Hash} label="Group ID">
          <span className="font-mono text-[11px]">{group.whatsappGroupId}</span>
        </Row>
        <Row icon={Smartphone} label="Our number in this group">
          {group.accountLabel}
        </Row>
        <Row icon={Users} label="Participants (last read from WhatsApp)">
          {group.participantCount !== null ? <span className="tabular">{group.participantCount}</span> : <Muted>Not read yet</Muted>}
        </Row>
        <Row icon={UserRound} label="Assigned team member">
          {group.assignedMemberName ?? <Muted>Nobody</Muted>}
        </Row>
        {group.lastSyncedAt ? (
          <Row icon={ShieldQuestion} label="Last group sync">
            {formatDateTime(group.lastSyncedAt)}
          </Row>
        ) : null}
      </Section>

      <Section
        title="Members right now"
        note="Read from WhatsApp only when someone asks, and shown with the time it was read — it is not kept up to date by itself. WhatsApp hides many members' numbers behind a private ID."
      >
        {live.state === "READY" ? (
          <>
            <p className="text-[11px] text-[color:var(--color-muted-foreground)]">
              {live.members.length} members, read {formatDateTime(live.readAt)}.
            </p>
            <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
              {live.members.map((m: LiveMember) => (
                <li key={m.rawId}>
                  <Link href={contactHref(m.rawId)} className="flex items-center gap-2 px-2.5 py-2 text-[12px] hover:bg-[var(--color-neutral-bg)]">
                    <span className="min-w-0 flex-1 truncate">{personLabel(m)}</span>
                    <PersonBadges person={m} />
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : live.state === "PENDING" ? (
          <p className="text-[12px] text-[color:var(--color-muted-foreground)]">Reading the member list from WhatsApp (asked {formatDateTime(live.requestedAt)})…</p>
        ) : live.state === "FAILED" ? (
          <p className="text-[12px] text-[color:var(--color-danger-fg)]">
            The last read failed ({formatDateTime(live.at)}): {live.error}
          </p>
        ) : (
          <p className="text-[12px] text-[color:var(--color-muted-foreground)]">Nobody has read this group&apos;s member list yet.</p>
        )}
        {profile.canRequestLive && group.isActive && live.state !== "PENDING" ? (
          <ReadMembersButton groupId={group.id} label={live.state === "READY" ? "Read again" : "Read members from WhatsApp"} />
        ) : null}
      </Section>

      <Section
        title="People seen in this group"
        note={`From messages this app stored${profile.seenTruncated ? " (the 200 most recent senders)" : ""} — not the member list: someone here may have left, and a member who never wrote is not here.`}
      >
        {profile.seen.length ? (
          <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
            {profile.seen.map((p: GroupPerson) => (
              <li key={p.senderId}>
                <Link href={contactHref(p.senderId)} className="flex items-center gap-2 px-2.5 py-2 text-[12px] hover:bg-[var(--color-neutral-bg)]">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{personLabel(p)}</span>
                    <span className="block text-[11px] text-[color:var(--color-muted-foreground)]">
                      {p.messages} {p.messages === 1 ? "message" : "messages"} · last {formatDateTime(p.lastAt)}
                    </span>
                  </span>
                  <PersonBadges person={p} />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-[color:var(--color-muted-foreground)]">Nobody has written here since this app started storing messages.</p>
        )}
      </Section>
    </PanelShell>
  );
}
