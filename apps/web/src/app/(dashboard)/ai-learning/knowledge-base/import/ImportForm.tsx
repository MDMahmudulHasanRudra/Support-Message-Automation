"use client";

import { Download, FileText, Link2, Type } from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Card,
  Field,
  Input,
  SectionHeader,
  Table,
  Td,
  Textarea,
  Th,
  useToast,
} from "@/components/ui";
import { queueKnowledgeImport, type KnowledgeImportState } from "@/server/actions/knowledgeImport";

const INITIAL: KnowledgeImportState = {};

type Mode = "paste" | "file" | "url";

/** What the file input offers, and what the hint promises — kept together so they can't disagree. */
const FILE_ACCEPT =
  ".txt,.md,.markdown,.pdf,.docx,.csv,.xlsx,text/plain,text/markdown,application/pdf," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
  "text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Three ways in, two destinations. Pasted text, a document and a fetched page all become the same
 * KnowledgeImport row for the worker to structure, so nothing downstream has to care which was
 * used. A question/answer spreadsheet is the exception and says so on screen: its rows already are
 * the answers, so they are created immediately and reported row by row, with no AI call anywhere
 * in the path.
 */
export function ImportForm({ knownModules }: { knownModules: string[] }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [state, formAction, pending] = useActionState(queueKnowledgeImport, INITIAL);
  const [mode, setMode] = useState<Mode>("paste");
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.queuedId) {
      showToast({
        tone: "success",
        title: "Import queued",
        description: "The worker is structuring it now. Entries appear in Pending Review as they are extracted.",
      });
      formRef.current?.reset();
      router.refresh();
      return;
    }
    if (state.spreadsheet) {
      showToast({
        tone: state.spreadsheet.created > 0 ? "success" : "danger",
        title: `${state.spreadsheet.created} entries created`,
        description:
          state.spreadsheet.created > 0
            ? "They are waiting in Pending Review — no AI read this file, so the answers are exactly as you wrote them."
            : "No row in that file could be used. The report below says why for each one.",
      });
      router.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when a new action result arrives
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-4">
      {/* The action branches on this. Without it every submit would be read as pasted text. */}
      <input type="hidden" name="mode" value={mode} />

      <Card>
        <SectionHeader
          title="What are you adding?"
          description="Anything that describes how your software actually behaves — a manual section, a configuration guide, a policy, an FAQ."
        />

        <div className="mb-5 flex flex-wrap gap-2">
          <ModeButton active={mode === "paste"} onClick={() => setMode("paste")} icon={Type} label="Write or paste text" />
          <ModeButton active={mode === "file"} onClick={() => setMode("file")} icon={FileText} label="Upload a file" />
          <ModeButton active={mode === "url"} onClick={() => setMode("url")} icon={Link2} label="Fetch a web page" />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Name"
            required={mode === "paste"}
            hint={
              mode === "paste"
                ? "How you'll recognise this in the review queue, e.g. 'MikroTik Integration Guide'."
                : "Optional — the file name or the page address is used if you leave this blank."
            }
          >
            <Input name="label" placeholder="MikroTik Integration Guide" />
          </Field>
          <Field
            label="Module"
            hint="Optional. Applied to every entry this produces, and it overrides the AI's own guess — you know your product."
          >
            <Input name="module" list="known-modules" placeholder="e.g. MikroTik Integration" />
            <datalist id="known-modules">
              {knownModules.map((module) => (
                <option key={module} value={module} />
              ))}
            </datalist>
          </Field>
        </div>

        <div className="mt-4">
          {mode === "paste" ? (
            <Field
              label="Text"
              hint="Paste as much as you like — it is split into sections automatically, and each section is read separately."
            >
              <Textarea
                name="text"
                rows={14}
                placeholder={
                  "Service tracking module allows administrators to create service requests, assign technicians, update service status, track service history, and close completed requests…"
                }
                className="leading-relaxed"
              />
            </Field>
          ) : mode === "url" ? (
            <Field
              label="Page address"
              required
              hint="A public documentation page. The readable text on it is fetched and structured exactly like pasted text, and the address is kept on every entry so a reviewer can check it against the source. A page behind a sign-in cannot be read — paste that text instead."
            >
              <Input name="url" type="url" placeholder="https://docs.example.com/billing/overview" />
            </Field>
          ) : (
            <div className="space-y-3">
              <Field
                label="File"
                hint="Documents (.pdf, .docx, .txt, .md) are read and structured by the AI. A question/answer spreadsheet (.xlsx, .csv) skips the AI entirely — its rows are stored as written. A scanned PDF has no text to read, so it has to be OCR'd first."
              >
                <Input type="file" name="file" accept={FILE_ACCEPT} className="h-auto py-2" />
              </Field>
              <ButtonLink href="/api/knowledge/import-template" download>
                <Download className="size-3.5" aria-hidden />
                Download spreadsheet template
              </ButtonLink>
            </div>
          )}
        </div>
      </Card>

      <Alert tone="info" title="Everything lands unverified">
        Nothing here decides what is true — not the AI that structures a document, and not a
        spreadsheet you upload. Entries wait in Pending Review until you check them, and only
        verified entries are ever used to answer a customer.
      </Alert>

      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}

      {state.fileErrors && state.fileErrors.length > 0 ? (
        <Alert tone="danger" title="That file could not be read">
          <ul className="space-y-1">
            {state.fileErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {state.spreadsheet ? <SpreadsheetReport report={state.spreadsheet} /> : null}

      <Button type="submit" loading={pending}>
        {mode === "file" ? "Import file" : mode === "url" ? "Fetch and queue" : "Queue for structuring"}
      </Button>
    </form>
  );
}

/**
 * Row-by-row outcome for a spreadsheet, in the same shape the automation-rules import reports.
 * A partial import is the normal case — one bad row must not discard a file somebody spent an
 * afternoon on — which only works if the operator can see exactly which rows were skipped.
 */
function SpreadsheetReport({ report }: { report: NonNullable<KnowledgeImportState["spreadsheet"]> }) {
  return (
    <Card>
      <SectionHeader title="Import report" description="No AI read this file — the answers are stored as written." />
      <div className="mb-3 flex flex-wrap gap-2 text-sm">
        <Badge color="green">{report.created} created</Badge>
        <Badge color={report.skipped > 0 ? "yellow" : "gray"}>{report.skipped} skipped</Badge>
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Row</Th>
            <Th>Title</Th>
            <Th>Result</Th>
            <Th>Reason</Th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => (
            <tr key={row.rowNumber}>
              <Td className="tabular">{row.rowNumber}</Td>
              <Td>{row.title || "—"}</Td>
              <Td>
                <Badge color={row.outcome === "CREATED" ? "green" : "yellow"} dot>
                  {row.outcome}
                </Badge>
              </Td>
              <Td className="text-xs text-[color:var(--color-muted-foreground)]">{row.reason}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function ModeButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Type;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-md)] border px-3 py-2.5 text-[13px] font-medium transition-[border-color,background-color,color] duration-[var(--duration-fast)] ${
        active
          ? "border-[var(--color-primary)] bg-[var(--color-neutral-bg)] text-[color:var(--color-foreground)]"
          : "border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-muted-foreground)] hover:border-[var(--color-border-strong)]"
      }`}
    >
      <Icon className="size-4" aria-hidden />
      {label}
    </button>
  );
}
