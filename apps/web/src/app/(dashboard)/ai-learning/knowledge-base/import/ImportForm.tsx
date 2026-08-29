"use client";

import { FileText, Type } from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Card, Field, Input, SectionHeader, Textarea, useToast } from "@/components/ui";
import { queueKnowledgeImport, type KnowledgeImportState } from "@/server/actions/knowledgeImport";

const INITIAL: KnowledgeImportState = {};

type Mode = "paste" | "file";

/**
 * Two ways in, one pipeline. Both end up as the same KnowledgeImport row, so the worker, the
 * review queue and the audit trail never have to care which was used.
 */
export function ImportForm({ knownModules }: { knownModules: string[] }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [state, formAction, pending] = useActionState(queueKnowledgeImport, INITIAL);
  const [mode, setMode] = useState<Mode>("paste");
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!state.queuedId) return;
    showToast({
      tone: "success",
      title: "Import queued",
      description: "The worker is structuring it now. Entries appear in Pending Review as they are extracted.",
    });
    formRef.current?.reset();
    router.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when a new action result arrives
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-4">
      <Card>
        <SectionHeader
          title="What are you adding?"
          description="Anything that describes how your software actually behaves — a manual section, a configuration guide, a policy, an FAQ."
        />

        <div className="mb-5 flex gap-2">
          <ModeButton active={mode === "paste"} onClick={() => setMode("paste")} icon={Type} label="Write or paste text" />
          <ModeButton active={mode === "file"} onClick={() => setMode("file")} icon={FileText} label="Upload a file" />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Name"
            required={mode === "paste"}
            hint="How you'll recognise this in the review queue, e.g. 'MikroTik Integration Guide'."
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
          ) : (
            <Field
              label="File"
              hint="Plain text only for now — .txt or .md. For a PDF or Word document, copy the text out and paste it instead."
            >
              <Input
                type="file"
                name="file"
                accept=".txt,.md,.markdown,.csv,text/plain,text/markdown"
                className="h-auto py-2"
              />
            </Field>
          )}
        </div>
      </Card>

      <Alert tone="info" title="Everything lands unverified">
        The AI structures what you give it; it does not decide what is true. Entries wait in Pending
        Review until you check them, and only verified entries are ever used to answer a customer.
      </Alert>

      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}

      <Button type="submit" loading={pending}>
        Queue for structuring
      </Button>
    </form>
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
