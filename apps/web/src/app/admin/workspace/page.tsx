import { redirect } from "next/navigation";
import { WORKSPACE_BASE, WORKSPACE_MODULES } from "@/lib/workspace";

/** The workspace has no page of its own yet: it opens its first module. */
export default function WorkspaceIndex() {
  redirect(`${WORKSPACE_BASE}/${WORKSPACE_MODULES[0].key}`);
}
