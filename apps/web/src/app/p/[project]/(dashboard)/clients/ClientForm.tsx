"use client";

import { useActionState, useEffect } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import Link from "@/components/ProjectLink";
import { Alert, Button, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { createClient, updateClient, type ClientFormState } from "@/server/actions/clients";
import { CLIENT_CHANNEL_LABELS, CLIENT_STATUSES, CLIENT_STATUS_LABELS, describeSharedKey, type ClientChannelKindValue } from "@support-automation/shared";

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
};

const PREFERRED: ClientChannelKindValue[] = ["PHONE", "WHATSAPP", "EMAIL", "MESSENGER", "INSTAGRAM", "TELEGRAM"];

/**
 * Add or edit a client. A refusal (and the "this looks like a client you already have" list) is
 * shown beside the fields, so what was typed is kept for correcting. Creating anyway after a
 * duplicate warning is a separate, explicit button — the form never decides that for the user.
 */
export function ClientForm({
  mode,
  clientId,
  values,
  options,
  canEditStatus = true,
}: {
  mode: "create" | "edit";
  clientId?: string;
  values: ClientFormValues;
  options: { members: Array<{ id: string; name: string }>; teams: Array<{ id: string; name: string }> };
  canEditStatus?: boolean;
}) {
  const action = mode === "create" ? createClient : updateClient.bind(null, clientId ?? "");
  const [state, formAction, pending] = useActionState<ClientFormState, FormData>(action, {});
  const router = useRouter();
  const { showToast } = useToast();
  // After a refusal React clears the fields; they come back from what the action returned.
  const v = (key: keyof ClientFormValues) => state.values?.[key] ?? values[key];

  useEffect(() => {
    if (!state.success) return;
    showToast({ tone: "success", title: mode === "create" ? "Client created" : "Client saved" });
    if (mode === "create" && state.clientId) router.push(`/clients/${state.clientId}`);
    else router.refresh();
  }, [state, mode, router, showToast]);

  return (
    <form action={formAction} className="space-y-5">
      {state.error ? (
        <Alert tone={state.duplicates?.length ? "warning" : "danger"} title={state.duplicates?.length ? "Possible duplicate" : "Not saved"}>
          {state.error}
          {state.duplicates?.length ? (
            <ul className="mt-2 space-y-1">
              {state.duplicates.map((d) => (
                <li key={d.clientId}>
                  <Link className="link font-medium" href={`/clients/${d.clientId}`}>
                    {d.name} ({d.code})
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name" required>
          <Input name="name" defaultValue={v("name")} required maxLength={200} />
        </Field>
        <Field label="Company / business">
          <Input name="companyName" defaultValue={v("companyName")} maxLength={200} />
        </Field>
        <Field label="Client code" hint={mode === "create" ? "Leave empty to generate one (CL-000123)." : "Must be unique in this project."}>
          <Input name="code" defaultValue={v("code")} maxLength={40} placeholder={mode === "create" ? "Generated" : undefined} />
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
        <Field label="Category">
          <Input name="category" defaultValue={v("category")} maxLength={80} />
        </Field>
        <Field label="Tags" hint="Separate with commas. Lower-case and de-duplicated.">
          <Input name="tags" defaultValue={v("tags")} />
        </Field>
        <Field label="Assigned staff">
          <Select name="assignedMemberId" defaultValue={v("assignedMemberId")}>
            <option value="">Nobody</option>
            {options.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Assigned team">
          <Select name="assignedTeamId" defaultValue={v("assignedTeamId")}>
            <option value="">No team</option>
            {options.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
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
          <Input name="preferredLanguage" defaultValue={v("preferredLanguage")} maxLength={40} placeholder="e.g. Bangla" />
        </Field>
      </div>

      {mode === "create" ? (
        <fieldset className="rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
          <legend className="px-1 text-sm font-medium">How to reach them</legend>
          <p className="mb-3 text-[13px] text-[color:var(--color-muted-foreground)]">
            More references (Messenger, Instagram, a WhatsApp group…) can be added on the client&apos;s page. Nothing is sent to any of these from here.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Phone">
              <Input name="phone" inputMode="tel" placeholder="+8801XXXXXXXXX" defaultValue={state.values?.phone ?? ""} />
            </Field>
            <Field label="WhatsApp number">
              <Input name="whatsapp" inputMode="tel" placeholder="+8801XXXXXXXXX" defaultValue={state.values?.whatsapp ?? ""} />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" placeholder="name@example.com" defaultValue={state.values?.email ?? ""} />
            </Field>
          </div>
        </fieldset>
      ) : null}

      <div className="grid grid-cols-1 gap-4">
        <Field label="Address">
          <Textarea name="address" defaultValue={v("address")} rows={2} maxLength={500} />
        </Field>
        <Field label="Business details">
          <Textarea name="businessDetails" defaultValue={v("businessDetails")} rows={2} maxLength={2000} />
        </Field>
        <Field label="Follow-up instructions" hint="Internal. Staff see this; it is never part of a message to the client.">
          <Textarea name="followUpInstructions" defaultValue={v("followUpInstructions")} rows={2} maxLength={2000} />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" loading={pending}>
          {mode === "create" ? "Create client" : "Save changes"}
        </Button>
        {mode === "create" && state.duplicates?.length ? (
          <Button
            type="submit"
            variant="secondary"
            loading={pending}
            name="confirmDuplicate"
            value="1"
            title="Creates a second client even though an identifier matches. Nothing is merged."
          >
            Create anyway
          </Button>
        ) : null}
        <Link href={mode === "create" ? "/clients" : `/clients/${clientId}`} className="text-sm text-[color:var(--color-muted-foreground)] underline underline-offset-2">
          Cancel
        </Link>
      </div>
    </form>
  );
}
