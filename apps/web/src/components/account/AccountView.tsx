import { redirect } from "next/navigation";
import { Badge, Card, PageHeader, SectionHeader } from "@/components/ui";
import { requireSession } from "@/server/auth";
import { getMyAccount, getMyDevices, getMySecurityActivity } from "@/server/account";
import { DevicesPanel, PasswordForm, PhotoForm, ProfileForm, TwoStepPanel, UsernameForm } from "./AccountForms";
import { USERNAME_RULE_TEXT, MIN_PASSWORD_LENGTH } from "@/lib/userRules";

/**
 * My account (ACCOUNT_SELF_SERVICE.md): the signed-in person's own profile, sign-in details, two-step
 * sign-in, devices and recent activity. Rendered at /account for everybody and at /admin/account inside
 * the Main Admin Portal — one view, so the two cannot drift.
 */

const DATE_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" });
const DATE = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium" });
const when = (d: Date | null, fallback = "Not recorded") => (d ? `${DATE_TIME.format(d)} (Dhaka)` : fallback);

export async function AccountView() {
  const session = await requireSession();
  const [account, devices, activity] = await Promise.all([getMyAccount(session), getMyDevices(session), getMySecurityActivity(session)]);
  if (!account) redirect("/login");
  const readOnly = account.isSupportIdentity || Boolean(session.support);

  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader title="My account" description="Your own profile, how you sign in, and where you are signed in. Changes here affect only your login." />

      {readOnly ? (
        <Card className="mb-6">
          <p className="text-sm text-[color:var(--color-muted-foreground)]">This is a support session. Nothing on this page can be changed from it.</p>
        </Card>
      ) : null}

      <div className="space-y-8">
        <section>
          <SectionHeader title="Profile" description="How you appear to colleagues across every workspace." />
          <Card>
            <div className="grid gap-8 md:grid-cols-[200px_1fr]">
              <PhotoForm name={account.name} avatarUrl={account.avatarUrl} disabled={readOnly} />
              <ProfileForm name={account.name} email={account.email} phone={account.phone} disabled={readOnly} />
            </div>
            <dl className="mt-6 grid gap-x-6 gap-y-3 border-t border-[var(--color-border)] pt-5 text-sm sm:grid-cols-2">
              <Fact label="Role" value={account.role ?? "No role"} />
              <Fact label="Employee" value={account.employee ? [account.employee.code, account.employee.jobTitle, account.employee.department].filter(Boolean).join(" · ") : "Not linked"} />
              <Fact label="Account created" value={DATE.format(account.createdAt)} />
              <Fact label="Last sign-in" value={when(account.lastLoginAt, "Never")} />
            </dl>
            <p className="mt-3 text-xs text-[color:var(--color-muted-foreground)]">Your role, employee record and project access are set by an administrator.</p>
          </Card>
        </section>

        <section>
          <SectionHeader title="Sign-in" description="Your username and password. Both need your current password to change." />
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
              <PasswordForm minLength={MIN_PASSWORD_LENGTH} disabled={readOnly} />
            </Card>
          </div>
        </section>

        <section>
          <SectionHeader
            title="Two-step sign-in"
            description="A 6-digit code from an authenticator app on your phone, asked after your password. Someone who learns your password still cannot sign in."
            action={account.mfaEnabledAt ? <Badge color="green">On</Badge> : <Badge color="gray">Off</Badge>}
          />
          <Card>
            <TwoStepPanel
              enabledAt={account.mfaEnabledAt ? when(account.mfaEnabledAt) : null}
              recoveryCodesLeft={account.recoveryCodesLeft}
              setupPending={account.mfaSetupPending}
              disabled={readOnly}
            />
          </Card>
        </section>

        <section>
          <SectionHeader title="Where you are signed in" description="Every browser holding a session for your login. Sign out any you do not recognise, then change your password." />
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
        </section>

        <section>
          <SectionHeader title="Recent activity" description="Your recent sign-in and account events, newest first." />
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
                      <span className="text-xs text-[color:var(--color-muted-foreground)]">
                        {[e.device, e.ipAddress, when(e.at)].filter(Boolean).join(" · ")}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">See something you did not do? Change your password, sign out other devices, and tell your administrator.</p>
        </section>
      </div>
    </div>
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
