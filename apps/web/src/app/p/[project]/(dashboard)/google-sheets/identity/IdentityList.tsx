"use client";

import { useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Button, ConfirmDialog, useToast } from "@/components/ui";
import { unlinkMyGoogleIdentityAction } from "@/server/actions/googleSheetsSettings";

interface IdentityView {
  id: string;
  email: string;
  displayName: string | null;
  verifiedAt: string;
}

/** The person's own linked Google accounts, each with Unlink (confirmed). */
export function IdentityList({ identities }: { identities: IdentityView[] }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [unlinking, setUnlinking] = useState<IdentityView | null>(null);

  if (identities.length === 0) {
    return <p className="text-[13px] text-[color:var(--color-muted-foreground)]">No Google account is linked to your login yet.</p>;
  }
  return (
    <>
      <ul className="divide-y divide-[var(--color-border)]">
        {identities.map((identity) => (
          <li key={identity.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="text-[13.5px] font-medium [overflow-wrap:anywhere]">{identity.email}</p>
              <p className="text-[12px] text-[color:var(--color-muted-foreground)]" suppressHydrationWarning>
                {identity.displayName ? `${identity.displayName} · ` : ""}confirmed by signing in on {new Date(identity.verifiedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
              </p>
            </div>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setUnlinking(identity)}>
              Unlink
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={unlinking !== null}
        onClose={() => setUnlinking(null)}
        onConfirm={() => {
          const target = unlinking;
          if (!target) return;
          startTransition(async () => {
            const result = await unlinkMyGoogleIdentityAction(target.id);
            setUnlinking(null);
            showToast({ tone: result.error ? "danger" : "success", title: result.error ?? result.success ?? "Unlinked" });
            router.refresh();
          });
        }}
        title={unlinking ? `Unlink ${unlinking.email}?` : ""}
        description="Changes it makes in Google from now on are not credited to you. Anything already credited stays as it is."
        confirmLabel="Unlink"
        tone="danger"
        loading={pending}
      />
    </>
  );
}
