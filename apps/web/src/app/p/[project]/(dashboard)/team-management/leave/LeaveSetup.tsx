"use client";

import { useTransition } from "react";
import { CalendarPlus } from "lucide-react";
import Link from "@/components/ProjectLink";
import { Button, Card, useToast } from "@/components/ui";
import { addCommonLeaveTypes } from "@/server/actions/teamManagement";

/**
 * The first thing Leave asks for: which kinds of leave this organisation has. One press adds the usual three, with no
 * allowance on any of them, so the app still states no policy of its own. Anything else is on Team Settings.
 */
export function LeaveSetup({ canManage }: { canManage: boolean }) {
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();

  if (!canManage) {
    return (
      <Card className="mb-4 p-5">
        <p className="text-[13.5px] text-[color:var(--color-muted-foreground)]">
          Leave can be recorded once an administrator chooses the kinds of leave your organisation has.
        </p>
      </Card>
    );
  }

  return (
    <Card className="mb-4 flex flex-wrap items-center justify-between gap-4 p-5">
      <div className="min-w-0 flex-1 basis-72">
        <h2 className="text-[15px] font-semibold text-[color:var(--color-foreground)]">Choose the kinds of leave you use</h2>
        <p className="mt-1 text-[13px] text-[color:var(--color-muted-foreground)]">
          Start with Annual, Sick and Casual. No allowance is set on them, and you can rename or add others in{" "}
          <Link href="/team-management/settings" className="link">
            Team Settings
          </Link>
          .
        </p>
      </div>
      <Button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await addCommonLeaveTypes();
            if (result.error) showToast({ tone: "danger", title: result.error });
            else showToast({ tone: "success", title: "Annual, Sick and Casual added", description: "You can record leave now." });
          })
        }
      >
        <CalendarPlus className="size-4" aria-hidden />
        {pending ? "Adding…" : "Add Annual, Sick and Casual"}
      </Button>
    </Card>
  );
}
