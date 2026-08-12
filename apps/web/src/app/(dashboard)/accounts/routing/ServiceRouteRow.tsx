"use client";

import { useActionState, useEffect } from "react";
import { Badge, Button, Select, useToast, type BadgeColor } from "@/components/ui";
import { updateServiceRoute, type ServiceRouteFormState } from "@/server/actions/whatsappRouting";

export interface ServiceRouteAccountOption {
  id: string;
  label: string;
  status: string;
}

export interface ServiceRouteRowData {
  serviceKey: string;
  serviceLabel: string;
  configuredAccountId: string | null;
  fallbackPolicy: string;
  resolvedLabel: string | null;
  resolvedSource: string | null;
  resolutionError: string | null;
}

const RESOLUTION_COLOR: Record<string, BadgeColor> = {
  CONFIGURED: "blue",
  PRIMARY_FALLBACK: "yellow",
  PRIMARY_DEFAULT: "green",
};

export function ServiceRouteRow({
  route,
  accounts,
}: {
  route: ServiceRouteRowData;
  accounts: ServiceRouteAccountOption[];
}) {
  const [state, formAction, pending] = useActionState<ServiceRouteFormState, FormData>(updateServiceRoute, {});
  const { showToast } = useToast();

  useEffect(() => {
    if (state.success) showToast({ tone: "success", title: `${route.serviceLabel} routing saved` });
    else if (state.error) showToast({ tone: "danger", title: "Could not save routing", description: state.error });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when a new action result arrives
  }, [state]);

  return (
    <form
      action={formAction}
      className="grid grid-cols-1 items-end gap-3 border-b border-[var(--color-border)] py-4 last:border-b-0 md:grid-cols-[1.2fr_1fr_1fr_auto]"
    >
      <input type="hidden" name="serviceKey" value={route.serviceKey} />

      <div>
        <p className="text-sm font-medium text-[color:var(--color-foreground)]">{route.serviceLabel}</p>
        {route.resolutionError ? (
          <p className="mt-1 text-xs text-[color:var(--color-danger)]">{route.resolutionError}</p>
        ) : (
          <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
            Currently sends via{" "}
            <span className="text-[color:var(--color-foreground)]">{route.resolvedLabel}</span>
            {route.resolvedSource ? (
              <>
                {" "}
                <Badge color={RESOLUTION_COLOR[route.resolvedSource] ?? "gray"}>{route.resolvedSource}</Badge>
              </>
            ) : null}
          </p>
        )}
      </div>

      <div>
        <label className="mb-1.5 block text-xs text-[color:var(--color-muted-foreground)]">Account</label>
        <Select name="accountId" defaultValue={route.configuredAccountId ?? ""}>
          <option value="">Primary (default)</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.label} — {account.status}
            </option>
          ))}
        </Select>
      </div>

      <div>
        <label className="mb-1.5 block text-xs text-[color:var(--color-muted-foreground)]">If unavailable</label>
        <Select name="fallbackPolicy" defaultValue={route.fallbackPolicy}>
          <option value="PRIMARY_FALLBACK">Fall back to Primary</option>
          <option value="STRICT_NO_FALLBACK">Show error, don&apos;t send</option>
        </Select>
      </div>

      <Button type="submit" variant="secondary" loading={pending}>
        Save
      </Button>
    </form>
  );
}
