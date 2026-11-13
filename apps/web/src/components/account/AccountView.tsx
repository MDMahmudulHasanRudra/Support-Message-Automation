import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { Activity, KeyRound, MonitorSmartphone, Palette, ShieldCheck, Smartphone, UserRound } from "lucide-react";
import { Alert, Badge, Card } from "@/components/ui";
import { requireSession } from "@/server/auth";
import { getMyAccount, getMyDevices, getMySecurityActivity } from "@/server/account";
import { getBranding } from "@/server/branding";
import { DevicesPanel, PasswordForm, PhotoForm, ProfileForm, TwoStepPanel, UsernameForm } from "./AccountForms";
import { AppearancePanel } from "./AppearancePanel";
import { USERNAME_RULE_TEXT } from "@/lib/userRules";
import { isThemePalette } from "@/lib/themes";
import { ThisDevicePanel } from "@/components/pwa/ThisDevicePanel";

/**
 * My account (ACCOUNT_SELF_SERVICE.md): the signed-in person's own profile, sign-in details, two-step
 * sign-in, devices, appearance and recent activity. Rendered at /account for everybody and at
 * /admin/account inside the Main Admin Portal — one view, so the two cannot drift. Presentation only:
 * every change still goes through the account actions and their own checks.
 */

const DATE_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" });
const DATE = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium" });
const when = (d: Date | null, fallback = "Not recorded") => (d ? `${DATE_TIME.format(d)} (Dhaka)` : fallback);

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "sign-in", label: "Sign-in & security" },
  { id: "two-step", label: "Two-step sign-in" },
  { id: "devices", label: "Devices" },
  { id: "appearance", label: "Appearance" },
  { id: "activity", label: "Activity" },
] as const;

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => [...w][0])
      .join("")
      .toUpperCase() || "?"
  );
}

export async function AccountView() {
  const session = await requireSession();
  const [account, devices, activity, brand] = await Promise.all([
    getMyAccount(session),
    getMyDevices(session),
    getMySecurityActivity(session),
    getBranding(),
  ]);
  if (!account) redirect("/login");
  const readOnly = account.isSupportIdentity || Boolean(session.support);
  const personalPalette = isThemePalette(session.themePalette) ? session.themePalette : null;
  const otherDevices = devices.filter((d) => !d.current).length;

  return (
    <div className="mx-auto w-full max-w-5xl">
      {/* Who this is: the photo, name, username and role, with the two security facts people check most. */}
      <section aria-label="Your account" className="mb-6 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-sm),var(--highlight-top)]">
        <div className="tide-field relative h-24 bg-[var(--tide-bg)] sm:h-28">
          <span
            aria-hidden
            className="absolute inset-0 opacity-70"
            style={{ background: "radial-gradient(120% 140% at 100% 0%, var(--tide-active) 0%, transparent 60%)" }}
          />
          <span aria-hidden className="absolute bottom-4 right-5 h-1 w-12 rounded-full bg-[var(--tide-mark)]" />
        </div>
        <div className="flex flex-col gap-4 px-5 pb-5 sm:flex-row sm:items-end sm:gap-5 sm:px-6">
          <span className="-mt-12 flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--color-neutral-bg)] text-2xl font-semibold text-[color:var(--color-muted-foreground)] ring-4 ring-[var(--color-surface)] shadow-[var(--shadow-md)]">
            {account.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- our own authenticated route; next/image would only re-encode a 256 px thumbnail
              <img src={account.avatarUrl} alt="" className="size-full object-cover" />
            ) : (
              <span aria-hidden>{initialsOf(account.name)}</span>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:var(--color-subtle-foreground)]">My account</p>
            <h1 className="mt-0.5 truncate text-xl font-semibold tracking-[-0.02em]">{account.name}</h1>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[color:var(--color-muted-foreground)]">
              <span className="font-mono text-[13px]">@{account.username}</span>
              <span aria-hidden>·</span>
              <span>{account.role ?? "No role"}</span>
              {account.employee?.jobTitle ? (
                <>
                  <span aria-hidden>·</span>
                  <span>{account.employee.jobTitle}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 sm:justify-end">
            {account.mfaEnabledAt ? <Badge color="green">Two-step on</Badge> : <Badge color="yellow">Two-step off</Badge>}
            <Badge color="gray">
              {devices.length} {devices.length === 1 ? "session" : "sessions"}
            </Badge>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-[var(--color-border)] px-5 py-4 text-sm sm:grid-cols-4 sm:px-6">
          <Fact label="Last sign-in" value={when(account.lastLoginAt, "Never")} />
          <Fact label="Password changed" value={account.passwordChangedAt ? DATE.format(account.passwordChangedAt) : "Not recorded"} />
          <Fact label="Account created" value={DATE.format(account.createdAt)} />
          <Fact label="Employee" value={account.employee ? [account.employee.code, account.employee.department].filter(Boolean).join(" · ") : "Not linked"} />
        </dl>
      </section>

      {readOnly ? (
        <div className="mb-6">
          <Alert tone="info" title="Support session">
            This is a support session. Nothing on this page can be changed from it.
          </Alert>
        </div>
      ) : null}

      <nav aria-label="On this page" className="mb-8 -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="shrink-0 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[12.5px] font-medium text-[color:var(--color-muted-foreground)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[color:var(--color-foreground)]"
          >
            {s.label}
          </a>
        ))}
      </nav>

      <div className="space-y-10">
        <Section id="profile" icon={<UserRound className="size-4" />} title="Profile" description="How you appear to colleagues across every workspace.">
          <Card>
            <div className="grid gap-8 md:grid-cols-[200px_1fr]">
              <PhotoForm name={account.name} avatarUrl={account.avatarUrl} disabled={readOnly} />
              <ProfileForm name={account.name} email={account.email} phone={account.phone} disabled={readOnly} />
            </div>
            <p className="mt-6 border-t border-[var(--color-border)] pt-4 text-xs text-[color:var(--color-muted-foreground)]">
              Your role ({account.role ?? "none"}), employee record and project access are set by an administrator.
            </p>
          </Card>
        </Section>

        <Section id="sign-in" icon={<KeyRound className="size-4" />} title="Sign-in & security" description="Your username and password. Both need your current password to change.">
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <h3 className="text-sm font-semibold">Username</h3>
              <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                Currently <span className="font-mono text-[color:var(--color-foreground)]">{account.username}</span>
                {account.usernameChangedAt ? ` · changed ${when(account.usernameChangedAt)}` : ""}
              </p>
              <UsernameForm current={account.username} rule={USERNAME_RULE_TEXT} disabled={readOnly} />
            </Card>
            <Card>
              <h3 className="text-sm font-semibold">Password</h3>
              <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">Last changed: {when(account.passwordChangedAt)}</p>
              <PasswordForm minLength={account.minPasswordLength} disabled={readOnly} />
            </Card>
          </div>
        </Section>

        <Section
          id="two-step"
          icon={<ShieldCheck className="size-4" />}
          title="Two-step sign-in"
          description="A 6-digit code from an authenticator app on your phone, asked after your password. Someone who learns your password still cannot sign in."
          action={account.mfaEnabledAt ? <Badge color="green">On</Badge> : <Badge color="gray">Off</Badge>}
        >
          <Card>
            <TwoStepPanel
              enabledAt={account.mfaEnabledAt ? when(account.mfaEnabledAt) : null}
              recoveryCodesLeft={account.recoveryCodesLeft}
              setupPending={account.mfaSetupPending}
              disabled={readOnly}
            />
          </Card>
        </Section>

        <Section
          id="devices"
          icon={<MonitorSmartphone className="size-4" />}
          title="Where you are signed in"
          description="Every browser holding a session for your login. Sign out any you do not recognise, then change your password."
          action={otherDevices > 0 ? <Badge color="gray">{otherDevices} other</Badge> : null}
        >
          <Card className="p-0">
            <DevicesPanel
              disabled={readOnly}
              devices={devices.map((d) => ({
                id: d.id,
                current: d.current,
                device: d.device,
                ipAddress: d.ipAddress,
                signedIn: when(d.createdAt),
                lastUsed: when(d.lastUsedAt),
                expires: DATE.format(d.expiresAt),
              }))}
            />
          </Card>
          <div id="this-device" className="mt-6 scroll-mt-4">
            <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
              <Smartphone className="size-4 text-[color:var(--color-muted-foreground)]" aria-hidden />
              This device
            </h3>
            <p className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">The phone app and customer alerts, set separately on each browser or phone.</p>
            <ThisDevicePanel disabled={readOnly} />
          </div>
        </Section>

        <Section id="appearance" icon={<Palette className="size-4" />} title="Appearance" description="Choose the colours you work in. Only you see your choice.">
          <Card>
            <AppearancePanel current={personalPalette} installationDefault={brand.themePalette} disabled={readOnly} />
          </Card>
        </Section>

        <Section id="activity" icon={<Activity className="size-4" />} title="Recent activity" description="Your recent sign-in and account events, newest first.">
          <Card className="p-0">
            {activity.length === 0 ? (
              <p className="p-6 text-sm text-[color:var(--color-muted-foreground)]">Nothing recorded yet. Sign-ins are recorded from now on.</p>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {activity.map((e) => {
                  const warn = /FAILURE|FAILED|LOCKED|RECOVERY|RESET|DISABLED/.test(e.event);
                  return (
                    <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3 text-sm">
                      <span className="flex items-center gap-2">
                        <span aria-hidden className={`size-1.5 rounded-full ${warn ? "bg-[var(--color-warning)]" : "bg-[var(--color-border-strong)]"}`} />
                        <span className={warn ? "font-medium" : ""}>{e.label}</span>
                      </span>
                      <span className="text-xs text-[color:var(--color-muted-foreground)]">{[e.device, e.ipAddress, when(e.at)].filter(Boolean).join(" · ")}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">See something you did not do? Change your password, sign out other devices, and tell your administrator.</p>
        </Section>
      </div>
    </div>
  );
}

function Section({
  id,
  icon,
  title,
  description,
  action,
  children,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent-bg)] text-[color:var(--color-accent-fg)] ring-1 ring-inset ring-[var(--color-accent-border)]">
            {icon}
          </span>
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="text-[15px] font-semibold tracking-[-0.01em]">
              {title}
            </h2>
            <p className="mt-0.5 text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">{description}</p>
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-[color:var(--color-muted-foreground)]">{label}</dt>
      <dd className="mt-0.5 truncate">{value}</dd>
    </div>
  );
}
