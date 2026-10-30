"use client";

import { useState } from "react";
import Link from "@/components/ProjectLink";
import { Badge } from "@/components/ui";
import { CampaignForm, type CampaignFormValue } from "./CampaignForm";

export interface CampaignRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  startsOn: string | null;
  endsOn: string | null;
  status: string;
  lead: { id: string; name: string } | null;
  posts: number;
  published: number;
}

export function CampaignList({ campaigns, canEdit, leads }: { campaigns: CampaignRow[]; canEdit: boolean; leads: Array<{ id: string; name: string }> | null }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (campaigns.length === 0) return <p className="py-8 text-center text-sm text-[color:var(--color-muted-foreground)]">No campaigns yet.</p>;
  return (
    <ul className="space-y-3">
      {campaigns.map((c) => {
        const value: CampaignFormValue = {
          id: c.id,
          name: c.name,
          description: c.description ?? "",
          color: c.color ?? "",
          startsOn: c.startsOn?.slice(0, 10) ?? "",
          endsOn: c.endsOn?.slice(0, 10) ?? "",
          leadId: c.lead?.id ?? "",
          status: c.status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE",
        };
        return (
          <li key={c.id} className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4" style={c.color ? { borderLeft: `4px solid ${c.color}` } : undefined}>
            {editing === c.id ? (
              <CampaignForm value={value} leads={leads} onDone={() => setEditing(null)} />
            ) : (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium">
                    {c.name} {c.status === "ARCHIVED" ? <Badge>Archived</Badge> : null}
                  </p>
                  {c.description ? <p className="text-sm text-[color:var(--color-muted-foreground)]">{c.description}</p> : null}
                  <p className="mt-1 text-xs text-[color:var(--color-subtle-foreground)]">
                    {c.startsOn ? `${c.startsOn.slice(0, 10)} → ${c.endsOn?.slice(0, 10) ?? "open"}` : "No dates"}
                    {c.lead ? ` · lead: ${c.lead.name}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <Link href={`/social/posts?view=all&campaign=${c.id}`} className="link tabular">
                    {c.posts} post(s)
                  </Link>
                  <Link href={`/social/analytics?campaign=${c.id}`} className="link tabular">
                    {c.published} published
                  </Link>
                  {canEdit ? (
                    <>
                      <Link href={`/social/new?campaign=${c.id}`} className="link">
                        Add post
                      </Link>
                      <button type="button" className="link" onClick={() => setEditing(c.id)}>
                        Edit
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
