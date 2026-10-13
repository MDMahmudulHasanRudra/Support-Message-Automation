"use client";

import { useActionState, useEffect } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Button, Field, Input } from "@/components/ui";
import { previewClientImport, type ClientImportFormState } from "@/server/actions/clientImport";

/** Step 1: choose a file. Nothing is imported — the next page is a preview with column mapping. */
export function ImportUpload({ maxMb, maxRows }: { maxMb: number; maxRows: number }) {
  const [state, formAction, pending] = useActionState<ClientImportFormState, FormData>(previewClientImport, {});
  const router = useRouter();
  useEffect(() => {
    if (state.jobId) router.push(`/clients/import/${state.jobId}`);
  }, [state, router]);
  return (
    <form action={formAction} className="space-y-3">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <Field label="CSV or Excel file" hint={`.csv or .xlsx, up to ${maxMb} MB and ${maxRows.toLocaleString()} rows. The first row must be the column names. Format phone columns as text so leading zeros survive.`}>
        <Input type="file" name="file" accept=".csv,.xlsx" required />
      </Field>
      <Button type="submit" loading={pending}>
        Upload and preview
      </Button>
    </form>
  );
}
