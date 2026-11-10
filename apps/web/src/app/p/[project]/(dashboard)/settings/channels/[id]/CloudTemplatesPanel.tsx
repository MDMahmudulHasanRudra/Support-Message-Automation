"use client";

import { useTransition } from "react";
import { Badge, Button, Card, useToast } from "@/components/ui";
import { useProjectRouter } from "@/components/ProjectLink";
import { syncTemplatesAction } from "@/server/actions/whatsappCloud";

export interface CloudTemplateRow {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  supported: boolean;
}

/** The templates Meta holds for this number. Written and approved in WhatsApp Manager; this only copies the list. */
export function CloudTemplatesPanel({ connectionId, templates }: { connectionId: string; templates: CloudTemplateRow[] }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [pending, start] = useTransition();
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold">Message templates</h2>
          <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">Written and approved in WhatsApp Manager. Needed to reach someone after 24 hours.</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await syncTemplatesAction(connectionId);
              if ("error" in r) showToast({ tone: "danger", title: r.error });
              else {
                showToast({ tone: "success", title: `${r.count} templates` });
                router.refresh();
              }
            })
          }
        >
          {pending ? "Syncing…" : "Sync templates"}
        </Button>
      </div>
      {templates.length ? (
        <ul className="mt-3 divide-y divide-[var(--color-border)]">
          {templates.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
              <span className="min-w-0 truncate">
                {t.name} <span className="text-[color:var(--color-muted-foreground)]">{t.language} · {t.category.toLowerCase()}</span>
              </span>
              <span className="flex gap-1.5">
                {!t.supported ? <Badge color="gray">Cannot be sent from here</Badge> : null}
                <Badge color={t.status === "APPROVED" ? "green" : t.status === "REJECTED" ? "red" : "yellow"}>{t.status.toLowerCase()}</Badge>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
