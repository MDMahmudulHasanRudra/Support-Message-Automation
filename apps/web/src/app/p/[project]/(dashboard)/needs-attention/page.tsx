import { projectPath } from "@/server/projectPaths";
import { redirect } from "next/navigation";

/** Preserves this URL for anyone with it bookmarked — the real implementation is the main Messages page's decision filter. */
export default async function NeedsAttentionRedirect() {
  redirect(await projectPath("/messages?decision=SUPPORT_REQUIRED"));
}
