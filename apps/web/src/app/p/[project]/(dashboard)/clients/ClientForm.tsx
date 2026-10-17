"use client";

import { useActionState, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Camera, Check, Search, ShieldCheck, Trash2, Users } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import Link from "@/components/ProjectLink";
import { Alert, Badge, Button, Checkbox, Dialog, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { createClient, updateClient, type ClientFormState } from "@/server/actions/clients";
import { searchLinkableGroups, type GroupCandidate } from "@/server/actions/clientGroupLinks";
import type { ClientFormOptions } from "@/server/clients";
import {
  addDuration,
  CLIENT_CHANNEL_LABELS,
  CLIENT_PHOTO_LIMITS,
  CLIENT_STATUSES,
  CLIENT_STATUS_LABELS,
  describeSharedKey,
  parseCalendarDay,
  SUBSCRIPTION_DURATION_UNITS,
  SUBSCRIPTION_DURATION_LABELS,
  SUBSCRIPTION_KINDS,
  SUBSCRIPTION_KIND_LABELS,
  type ClientChannelKindValue,
  type ClientRequirableField,
} from "@support-automation/shared";
import { countryName, countryOptions, readPhone, suggestedCurrency } from "@/lib/clientPhone";
import { formatDay } from "@/lib/clientDisplay";
import { shrinkPicture } from "@/lib/clientPhotoResize";

export interface ClientFormValues {
  name: string;
  code: string;
  companyName: string;
  status: string;
  category: string;
  tags: string;
  preferredChannel: string;
  preferredLanguage: string;
  address: string;
  businessDetails: string;
  followUpInstructions: string;
  assignedMemberId: string;
  assignedTeamId: string;
  country: string;
  preferredCurrency: string;
  soldByMemberId: string;
}

export const EMPTY_CLIENT_VALUES: ClientFormValues = {
  name: "",
  code: "",
  companyName: "",
  status: "ACTIVE",
  category: "",
  tags: "",
  preferredChannel: "",
  preferredLanguage: "",
  address: "",
  businessDetails: "",
  followUpInstructions: "",
  assignedMemberId: "",
  assignedTeamId: "",
  country: "",
  preferredCurrency: "",
  soldByMemberId: "",
};

const PREFERRED: ClientChannelKindValue[] = ["PHONE", "WHATSAPP", "EMAIL", "MESSENGER", "INSTAGRAM", "TELEGRAM"];

export interface ClientFormContext {
  requiredFields: ClientRequirableField[];
  defaultCountry: string | null;
  /** The project's enabled billing currencies (suggestions for the preferred currency). */
  currencies: string[];
  /** Services already sold in this project, offered as suggestions. */
  services: string[];
  accounts: Array<{ id: string; label: string; phoneNumber: string | null; status: string }>;
  canLinkGroups: boolean;
  canSellSubscriptions: boolean;
  today: string;
}

function Section({ step, title, hint, children, id }: { step: string; title: string; hint?: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="space-y-4">
      <div className="flex items-baseline gap-2 border-b border-[var(--color-border)] pb-2">
        <span className="font-[family-name:var(--font-mono)] text-xs text-[color:var(--color-muted-foreground)]">{step}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint ? <span className="text-xs text-[color:var(--color-muted-foreground)]">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Add or edit a client (CLIENTS_V3.md §6) — a guided form inside the existing Clients module.
 *
 * Every ordinary field is optional unless this project marked it required (Settings → Clients); a
 * client with nothing but a generated code needs a separate, deliberate press. Team, staff and seller
 * come from the project's real roster; a WhatsApp group from the groups its accounts have synced, and
 * is linked only after a confirmation. A refusal keeps everything typed.
 */
export function ClientForm({
  mode,
  clientId,
  values,
  options,
  context,
  canEditStatus = true,
}: {
  mode: "create" | "edit";
  clientId?: string;
  values: ClientFormValues;
  options: ClientFormOptions;
  context: ClientFormContext;
  canEditStatus?: boolean;
}) {
  const action = mode === "create" ? createClient : updateClient.bind(null, clientId ?? "");
  const [state, formAction, pending] = useActionState<ClientFormState, FormData>(action, {});
  const router = useRouter();
  const { showToast } = useToast();
  const v = (key: keyof ClientFormValues) => state.values?.[key] ?? values[key];
  const required = new Set(context.requiredFields);
  const req = (key: ClientRequirableField) => required.has(key);

  // Controlled where one field drives another.
  const [country, setCountry] = useState(v("country"));
  const [currency, setCurrency] = useState(v("preferredCurrency"));
  const [phone, setPhone] = useState(state.values?.phone ?? "");
  const [whatsappSame, setWhatsappSame] = useState((state.values?.whatsappSame ?? "1") === "1");
  const [teamId, setTeamId] = useState(v("assignedTeamId"));
  const [memberId, setMemberId] = useState(v("assignedMemberId"));
  const [photo, setPhoto] = useState<{ url: string; file: File } | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const photoField = useRef<HTMLInputElement>(null);
  const countries = useMemo(() => countryOptions(), []);
  const reading = readPhone(phone, country || context.defaultCountry);
  const currencySuggestion = suggestedCurrency(country);

  // Subscription section.
  const [subOpen, setSubOpen] = useState(Boolean(state.values?.subService));
  const [subStart, setSubStart] = useState(state.values?.subStartDate ?? context.today);
  const [subValue, setSubValue] = useState(state.values?.subDurationValue ?? "1");
  const [subUnit, setSubUnit] = useState(state.values?.subDurationUnit ?? "MONTH");
  const subEnd = useMemo(() => {
    const start = parseCalendarDay(subStart);
    const n = Number(subValue);
    return start && Number.isInteger(n) && n > 0 ? addDuration(start, n, subUnit as never) : null;
  }, [subStart, subValue, subUnit]);

  // WhatsApp group section.
  const [accountId, setAccountId] = useState(state.values?.linkAccountId ?? "");
  const [groupQuery, setGroupQuery] = useState("");
  const [candidates, setCandidates] = useState<GroupCandidate[] | null>(null);
  const [chosen, setChosen] = useState<GroupCandidate | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!state.success) return;
    showToast({ tone: "success", title: mode === "create" ? "Client created" : "Client saved" });
    if (mode === "create" && state.clientId) router.push(`/clients/${state.clientId}`);
    else router.refresh();
  }, [state, mode, router, showToast]);

  // Look up groups as the person types (debounced); a reader that refuses returns an empty list.
  useEffect(() => {
    if (!accountId || mode !== "create") return;
    let live = true;
    const t = setTimeout(async () => {
      const found = await searchLinkableGroups(accountId, groupQuery);
      if (live) setCandidates(found);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [accountId, groupQuery, mode]);

  const activeTeams = options.allTeams.filter((t) => t.active || t.id === values.assignedTeamId);
  const teamMembers = options.roster.filter((m) => (m.active || m.id === values.assignedMemberId) && (!teamId || m.teamId === teamId));
  const sellers = options.roster.filter((m) => m.active || m.id === values.soldByMemberId);
  const sellersByTeam = new Map<string, typeof sellers>();
  for (const m of sellers) sellersByTeam.set(m.teamName ?? "No team", [...(sellersByTeam.get(m.teamName ?? "No team") ?? []), m]);

  async function choosePhoto(file: File | undefined) {
    setPhotoError(null);
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      setPhotoError("Choose a JPEG, PNG or WebP picture.");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setPhotoError("That picture is larger than 15 MB.");
      return;
    }
    try {
      const small = await shrinkPicture(file);
      if (small.size > CLIENT_PHOTO_LIMITS.maxBytes) throw new Error("Even resized, the picture is too large.");
      const transfer = new DataTransfer();
      transfer.items.add(small);
      if (photoField.current) photoField.current.files = transfer.files;
      setPhoto({ url: URL.createObjectURL(small), file: small });
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "The picture could not be read.");
    }
  }
  function clearPhoto() {
    setPhoto(null);
    if (photoField.current) photoField.current.value = "";
    if (photoInput.current) photoInput.current.value = "";
  }

  const label = (text: string, key?: ClientRequirableField) => (
    <>
      {text}
      {key && req(key) ? <span className="ml-0.5 text-[color:var(--color-danger)]">*</span> : null}
    </>
  );
  const accountLabel = (id: string) => {
    const a = context.accounts.find((x) => x.id === id);
    return a ? `${a.label}${a.phoneNumber ? ` (${a.phoneNumber})` : ""}` : "";
  };

  return (
    <form action={formAction} className="space-y-7">
      {state.error ? (
        <Alert tone={state.duplicates?.length || state.needsBlankConfirm ? "warning" : "danger"} title={state.duplicates?.length ? "Possible duplicate" : state.needsBlankConfirm ? "Nothing identifies this client" : "Not saved"}>
          {state.error}
          {state.duplicates?.length ? (
            <ul className="mt-2 space-y-1">
              {state.duplicates.map((d) => (
                <li key={d.clientId}>
                  <Link className="link font-medium" href={`/clients/${d.clientId}`}>
                    {d.name || "Unnamed client"} ({d.code})
                  </Link>{" "}
                  <span className="opacity-80">
                    — {d.sharedKeys.map(describeSharedKey).join(", ")}
                    {d.status === "ARCHIVED" ? " · archived: restore it instead of creating a second record" : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      {mode === "create" ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-success-border)] bg-[var(--color-success-bg)] px-4 py-3">
          <p className="text-sm font-semibold text-[color:var(--color-success-fg)]">One client profile. Everything connected.</p>
          <p className="mt-0.5 text-xs text-[color:var(--color-success-fg)]">
            Enter only what you know — a client code is generated for you.{required.size ? " Fields marked * are required in this project." : " This project requires no particular field."}
          </p>
        </div>
      ) : null}

      {mode === "create" ? (
        <div className="flex flex-wrap items-center gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-4">
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local preview of the resized picture
            <img src={photo.url} alt="Chosen profile picture" className="size-16 rounded-2xl object-cover ring-1 ring-[var(--color-border)]" />
          ) : (
            <span className="flex size-16 items-center justify-center rounded-2xl bg-[var(--color-info-bg)] text-[color:var(--color-info-fg)]">
              <Camera className="size-6" aria-hidden />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{label("Client profile picture", "photo")}</p>
            <p className="text-xs text-[color:var(--color-muted-foreground)]">Optional · JPEG, PNG or WebP · resized to a small thumbnail before upload; location and camera details are removed.</p>
            {photoError ? <p className="mt-1 text-xs font-medium text-[color:var(--color-danger)]">{photoError}</p> : null}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => photoInput.current?.click()}>
              <Camera className="size-3.5" aria-hidden /> {photo ? "Change" : "Choose photo"}
            </Button>
            {photo ? (
              <Button type="button" variant="ghost" size="sm" onClick={clearPhoto} aria-label="Remove the chosen picture">
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            ) : null}
          </div>
          <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => choosePhoto(e.target.files?.[0])} />
          <input ref={photoField} type="file" name="photo" className="hidden" tabIndex={-1} aria-hidden />
        </div>
      ) : null}

      <Section step="01" title="Client identity" hint="Flexible fields">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={label("Client / contact name", "name")}>
            <Input name="name" defaultValue={v("name")} maxLength={200} placeholder="Person or company name" />
          </Field>
          <Field label={label("Company / business", "companyName")}>
            <Input name="companyName" defaultValue={v("companyName")} maxLength={200} placeholder="Optional" />
          </Field>
          <Field label="Client code" hint={mode === "create" ? "Leave empty to generate one (CL-000123)." : "Must be unique in this project."}>
            <Input name="code" defaultValue={v("code")} maxLength={40} placeholder={mode === "create" ? "Automatic if blank" : undefined} />
          </Field>
          {canEditStatus ? (
            <Field label="Status">
              <Select name="status" defaultValue={v("status")}>
                {CLIENT_STATUSES.filter((s) => s !== "ARCHIVED").map((s) => (
                  <option key={s} value={s}>
                    {CLIENT_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label={label("Category", "category")}>
            <Input name="category" defaultValue={v("category")} maxLength={80} placeholder="e.g. Reseller, Corporate" />
          </Field>
          <Field label="Tags" hint="Separate with commas.">
            <Input name="tags" defaultValue={v("tags")} placeholder="vip, dhaka" />
          </Field>
        </div>
      </Section>

      <Section step="02" title="Worldwide contact & billing currency">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {mode === "create" ? (
            <Field
              label={label("International mobile / WhatsApp", "phone")}
              hint={
                phone ? (
                  reading.valid ? (
                    <span className="text-[color:var(--color-success-fg)]">
                      <Check className="mr-1 inline size-3" aria-hidden />
                      Saved as {reading.e164}
                      {reading.country && reading.country !== country ? (
                        <>
                          {" "}·{" "}
                          <button type="button" className="underline" onClick={() => setCountry(reading.country!)}>
                            Use {countryName(reading.country)}
                          </button>
                        </>
                      ) : null}
                    </span>
                  ) : (
                    (reading.note ?? "Type the number with its country code.")
                  )
                ) : (
                  "With the country code: +88017…, +97150…, +1 415…"
                )
              }
            >
              <Input name="phone" inputMode="tel" placeholder="+88017… or +97150…" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
          ) : null}
          <Field label={label("Country", "country")} hint={country ? undefined : "Picked from the number when it is certain; you can always choose."}>
            <Select name="country" value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="">Not set</option>
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name} (+{c.callingCode})
                </option>
              ))}
            </Select>
          </Field>
          {mode === "create" ? (
            <div className="sm:col-span-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={whatsappSame} onChange={(e) => setWhatsappSame(e.target.checked)} />
                The same number is on WhatsApp
              </label>
              <input type="hidden" name="whatsappSame" value={whatsappSame ? "1" : "0"} />
            </div>
          ) : null}
          {mode === "create" && !whatsappSame ? (
            <Field label="WhatsApp number (if different)">
              <Input name="whatsapp" inputMode="tel" placeholder="+8801…" defaultValue={state.values?.whatsapp ?? ""} />
            </Field>
          ) : null}
          {mode === "create" ? (
            <Field label={label("Email address", "email")}>
              <Input name="email" type="email" placeholder="email@example.com" defaultValue={state.values?.email ?? ""} />
            </Field>
          ) : null}
          <Field
            label={label("Preferred currency", "preferredCurrency")}
            hint={
              currencySuggestion && currencySuggestion !== currency ? (
                <>
                  {countryName(country)} usually pays in {currencySuggestion}.{" "}
                  <button type="button" className="underline" onClick={() => setCurrency(currencySuggestion)}>
                    Use {currencySuggestion}
                  </button>{" "}
                  — a suggestion only; each invoice keeps its own currency.
                </>
              ) : (
                "A suggestion for new invoices, never a rule."
              )
            }
          >
            <Input name="preferredCurrency" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} list="client-currencies" placeholder="No preferred currency" maxLength={3} />
            <datalist id="client-currencies">
              {context.currencies.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label={label("Address / location", "address")}>
            <Input name="address" defaultValue={v("address")} maxLength={500} placeholder="Optional street or city" />
          </Field>
          <Field label="Preferred channel">
            <Select name="preferredChannel" defaultValue={v("preferredChannel")}>
              <option value="">No preference</option>
              {PREFERRED.map((k) => (
                <option key={k} value={k}>
                  {CLIENT_CHANNEL_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Preferred language">
            <Input name="preferredLanguage" defaultValue={v("preferredLanguage")} maxLength={40} placeholder="e.g. Bangla, Arabic" />
          </Field>
        </div>
      </Section>

      <Section step="03" title="Team & seller" hint="From your real team roster">
        {options.roster.length === 0 ? (
          <Alert tone="info">
            No team members yet. Add them under WhatsApp → <Link href="/team-members" className="link">Team Members</Link> and group them under <Link href="/teams" className="link">Teams</Link>; they then appear here.
          </Alert>
        ) : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label={label("Team", "assignedTeamId")}>
            <Select
              name="assignedTeamId"
              value={teamId}
              onChange={(e) => {
                setTeamId(e.target.value);
                const m = options.roster.find((x) => x.id === memberId);
                if (m && e.target.value && m.teamId !== e.target.value) setMemberId("");
              }}
            >
              <option value="">No team</option>
              {activeTeams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.active ? "" : " (disabled)"}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={label("Assigned staff", "assignedMemberId")} hint={teamId ? "Members of the chosen team." : undefined}>
            <Select name="assignedMemberId" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
              <option value="">Nobody</option>
              {teamMembers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.designation ? ` — ${m.designation}` : ""}
                  {m.active ? "" : " (inactive)"}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={label("Sold by", "soldByMemberId")} hint="Who brought this client in. Kept with each sale.">
            <Select name="soldByMemberId" defaultValue={v("soldByMemberId")}>
              <option value="">Not recorded</option>
              {[...sellersByTeam.entries()].map(([team, list]) => (
                <optgroup key={team} label={team}>
                  {list.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.designation ? ` — ${m.designation}` : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
        </div>
      </Section>

      {mode === "create" && context.canLinkGroups ? (
        <Section step="04" title="WhatsApp group" hint="Existing groups only">
          {context.accounts.length === 0 ? (
            <Alert tone="info">No WhatsApp account is connected to this project yet, so there is no group to link.</Alert>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="WhatsApp account">
                  <Select
                    value={accountId}
                    onChange={(e) => {
                      setAccountId(e.target.value);
                      setChosen(null);
                      setConfirmed(false);
                      setCandidates(null);
                    }}
                  >
                    <option value="">Choose an account…</option>
                    {context.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {accountLabel(a.id)}
                        {a.status !== "CONNECTED" ? " — not connected" : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
                {accountId ? (
                  <Field label="Find the group">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[color:var(--color-muted-foreground)]" aria-hidden />
                      <Input value={groupQuery} onChange={(e) => setGroupQuery(e.target.value)} placeholder="Group name or id" className="pl-9" />
                    </div>
                  </Field>
                ) : null}
              </div>
              {accountId && !chosen ? (
                <ul className="max-h-56 divide-y divide-[var(--color-border)] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
                  {candidates === null ? <li className="px-3 py-2 text-sm text-[color:var(--color-muted-foreground)]">Loading groups…</li> : null}
                  {candidates?.length === 0 ? <li className="px-3 py-2 text-sm text-[color:var(--color-muted-foreground)]">No active group matches on this account.</li> : null}
                  {candidates?.map((g) => (
                    <li key={g.groupId}>
                      <button
                        type="button"
                        disabled={Boolean(g.linkedTo)}
                        onClick={() => {
                          setChosen(g);
                          setConfirmOpen(true);
                        }}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-[var(--color-neutral-bg)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <Users className="size-4 shrink-0 text-[color:var(--color-muted-foreground)]" aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{g.name}</span>
                        {g.participantCount ? <span className="text-xs text-[color:var(--color-muted-foreground)]">{g.participantCount} members</span> : null}
                        {g.linkedTo ? <Badge color="gray">Linked to {g.linkedTo.code}</Badge> : g.isMonitored ? <Badge color="blue">Monitored</Badge> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {chosen ? (
                <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-success-border)] bg-[var(--color-success-bg)] px-3 py-2 text-sm">
                  <Users className="size-4 text-[color:var(--color-success-fg)]" aria-hidden />
                  <span className="flex-1 font-medium text-[color:var(--color-success-fg)]">
                    {chosen.name} <span className="font-normal opacity-80">· {accountLabel(accountId)}</span>
                  </span>
                  {confirmed ? <Badge color="green">Confirmed</Badge> : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setChosen(null);
                      setConfirmed(false);
                    }}
                  >
                    Change
                  </Button>
                </div>
              ) : null}
              {chosen && confirmed ? (
                <>
                  <input type="hidden" name="linkAccountId" value={accountId} />
                  <input type="hidden" name="linkGroupId" value={chosen.groupId} />
                  <input type="hidden" name="confirmGroup" value="1" />
                </>
              ) : null}
              <p className="text-xs text-[color:var(--color-muted-foreground)]">Linking only records where you support this client. It sends nothing and does not change the group&apos;s monitoring or AI.</p>
            </div>
          )}
          <Dialog
            open={confirmOpen}
            onClose={() => {
              setConfirmOpen(false);
              if (!confirmed) setChosen(null);
            }}
            title="Link this WhatsApp group?"
            description={chosen ? `${chosen.name} on ${accountLabel(accountId)} will be recorded as this client's group. Nothing is sent, and its monitoring and AI settings stay as they are.` : undefined}
            footer={
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setConfirmOpen(false);
                    setChosen(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    setConfirmed(true);
                    setConfirmOpen(false);
                  }}
                >
                  <ShieldCheck className="size-4" aria-hidden /> Confirm link
                </Button>
              </div>
            }
          />
        </Section>
      ) : null}

      {mode === "create" && context.canSellSubscriptions ? (
        <Section step="05" title="Subscription" hint="Optional — add the first plan now or later">
          {!subOpen ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => setSubOpen(true)}>
              + Add a subscription
            </Button>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Service / plan" className="lg:col-span-2">
                  <Input name="subService" list="client-services" defaultValue={state.values?.subService ?? ""} placeholder="e.g. Tiger IPTV" maxLength={120} />
                  <datalist id="client-services">
                    {context.services.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </Field>
                <Field label="Type">
                  <Select name="subKind" defaultValue={state.values?.subKind ?? "PAID"}>
                    {SUBSCRIPTION_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {SUBSCRIPTION_KIND_LABELS[k]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Starts on">
                  <Input type="date" name="subStartDate" value={subStart} onChange={(e) => setSubStart(e.target.value)} />
                </Field>
                <Field label="Duration">
                  <Input type="number" min={1} name="subDurationValue" value={subValue} onChange={(e) => setSubValue(e.target.value)} />
                </Field>
                <Field label="Unit">
                  <Select name="subDurationUnit" value={subUnit} onChange={(e) => setSubUnit(e.target.value)}>
                    {SUBSCRIPTION_DURATION_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {SUBSCRIPTION_DURATION_LABELS[u][1]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex items-end lg:col-span-2">
                  <p className="text-sm">
                    Expires on <strong>{subEnd ? formatDay(subEnd) : "—"}</strong>
                    <span className="ml-1 text-xs text-[color:var(--color-muted-foreground)]">(the seller above is credited)</span>
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSubOpen(false);
                }}
              >
                Remove subscription
              </Button>
            </div>
          )}
        </Section>
      ) : null}

      <Section step={mode === "create" ? "06" : "04"} title="Notes for the team" hint="Internal — never sent to the client">
        <div className="grid grid-cols-1 gap-4">
          <Field label="Business details">
            <Textarea name="businessDetails" defaultValue={v("businessDetails")} rows={2} maxLength={2000} />
          </Field>
          <Field label="Follow-up instructions">
            <Textarea name="followUpInstructions" defaultValue={v("followUpInstructions")} rows={2} maxLength={2000} />
          </Field>
        </div>
      </Section>

      <div className="sticky bottom-0 -mx-6 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-3">
        <Button type="submit" loading={pending}>
          <Check className="size-4" aria-hidden /> {mode === "create" ? "Create client" : "Save changes"}
        </Button>
        {mode === "create" && state.duplicates?.length ? (
          <Button type="submit" variant="secondary" loading={pending} name="confirmDuplicate" value="1" title="Creates a second client even though an identifier matches. Nothing is merged.">
            Create anyway
          </Button>
        ) : null}
        {mode === "create" && state.needsBlankConfirm ? (
          <Button type="submit" variant="secondary" loading={pending} name="confirmBlank" value="1" title="Saves a client known only by its generated code. You can fill in the rest later.">
            Create with only a client code
          </Button>
        ) : null}
        <Link href={mode === "create" ? "/clients" : `/clients/${clientId}`} className="text-sm text-[color:var(--color-muted-foreground)] underline underline-offset-2">
          Cancel
        </Link>
      </div>
    </form>
  );
}
