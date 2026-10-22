"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Table, Td, Th } from "@/components/ui";
import { readGoogleSharingAction } from "@/server/actions/googleSheetMembers";
import type { GoogleSharing } from "@/server/google/sharing";

/** Google Drive's role names, as Google's own sharing dialog shows them. */
const GOOGLE_ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  organizer: "Manager",
  fileOrganizer: "Content manager",
  writer: "Editor",
  commenter: "Commenter",
  reader: "Viewer",
};

/**
 * Google Drive's sharing list, read live when asked for (it is a call to Google, so it is not made on
 * every page view). Reference only: nothing here changes the app's members.
 */
export function GoogleSharingPanel({ spreadsheetId }: { spreadsheetId: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ error: string } | { sharing: GoogleSharing } | null>(null);

  return (
    <div className="space-y-3">
      <Button
        variant="secondary"
        size="sm"
        loading={pending}
        onClick={() => startTransition(async () => setResult(await readGoogleSharingAction(spreadsheetId)))}
      >
        {result ? "Read again from Google" : "Show Google's sharing list"}
      </Button>

      {result === null ? null : "error" in result ? (
        <Alert tone="danger" title="Not shown">
          {result.error}
        </Alert>
      ) : !result.sharing.visible ? (
        <Alert tone="info" title="Google did not show the sharing list">
          {result.sharing.reason}
        </Alert>
      ) : (
        <>
          <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
            As Google reports it to {result.sharing.via}
            {result.sharing.capped ? " (first 500 entries)" : ""}.
          </p>
          <Table>
            <thead>
              <tr>
                <Th>Who</Th>
                <Th>Role in Google</Th>
              </tr>
            </thead>
            <tbody>
              {result.sharing.entries.map((entry, i) => (
                <tr key={`${entry.emailAddress ?? entry.domain ?? entry.type}-${i}`}>
                  <Td>
                    {entry.type === "anyone" ? (
                      "Anyone with the link"
                    ) : entry.type === "domain" ? (
                      `Anyone at ${entry.domain ?? "the organisation"}`
                    ) : (
                      <>
                        <span className="font-medium">{entry.displayName ?? entry.emailAddress ?? "Unknown"}</span>
                        {entry.displayName && entry.emailAddress ? (
                          <span className="text-[12px] text-[color:var(--color-muted-foreground)]"> {entry.emailAddress}</span>
                        ) : null}
                        {entry.type === "group" ? <span className="text-[12px] text-[color:var(--color-muted-foreground)]"> (group)</span> : null}
                        {entry.deleted ? <span className="text-[12px] text-[color:var(--color-muted-foreground)]"> (deleted account)</span> : null}
                      </>
                    )}
                  </Td>
                  <Td>{GOOGLE_ROLE_LABELS[entry.role] ?? entry.role}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </div>
  );
}
