import { redirect } from "next/navigation";

/** Preserves this URL for anyone with it bookmarked — the real implementation is the main Messages page's decision filter. */
export default function NeedsAttentionRedirect() {
  redirect("/messages?decision=SUPPORT_REQUIRED");
}
