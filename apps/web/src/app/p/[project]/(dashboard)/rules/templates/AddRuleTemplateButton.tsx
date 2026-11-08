"use client";

import { useTransition } from "react";
import { Button, useToast } from "@/components/ui";
import { useProjectRouter } from "@/components/ProjectLink";
import { addRuleTemplate } from "@/server/actions/menuBots";

export function AddRuleTemplateButton({ id }: { id: string }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await addRuleTemplate(id);
          if ("error" in r) showToast({ tone: "danger", title: r.error });
          else router.push(`/rules/${r.id}/edit`);
        })
      }
    >
      {pending ? "Adding…" : "Add as draft"}
    </Button>
  );
}
