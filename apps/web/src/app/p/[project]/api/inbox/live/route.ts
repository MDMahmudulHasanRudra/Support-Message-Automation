import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { subscribeInboxChanges } from "@/server/inboxLive";
import { activeProjectId } from "@/server/projectContext";

export const dynamic = "force-dynamic";

/** A connection is checked again by reconnecting, so a sign-out or a lost permission ends it within this time. */
const MAX_CONNECTION_MS = 5 * 60_000;
const KEEP_ALIVE_MS = 25_000;

/**
 * "Something changed in this project, look again" (AGENT_APP.md). It carries no message, name or id, only
 * the hint: the browser then refreshes through the ordinary page. INBOX_LIVE_DISABLED=true turns it off and
 * the inbox goes back to refreshing every four seconds.
 */
export async function GET(request: NextRequest) {
  if (process.env.INBOX_LIVE_DISABLED === "true") return new NextResponse(null, { status: 404 });
  if (!(await getSession())) return new NextResponse(null, { status: 401 });
  const access = await checkPermission("messages.view");
  if ("denied" in access) return new NextResponse(null, { status: 403 });
  const projectId = await activeProjectId();

  const encoder = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (text: string) => {
        if (open) controller.enqueue(encoder.encode(text));
      };
      const unsubscribe = subscribeInboxChanges(projectId, () => send("event: change\ndata: 1\n\n"));
      const keepAlive = setInterval(() => send(": ping\n\n"), KEEP_ALIVE_MS);
      stop = () => {
        if (!open) return;
        open = false;
        unsubscribe();
        clearInterval(keepAlive);
        clearTimeout(limit);
        try {
          controller.close();
        } catch {
          // The browser already went away.
        }
      };
      const limit = setTimeout(() => stop(), MAX_CONNECTION_MS);
      request.signal.addEventListener("abort", () => stop());
      send("retry: 5000\n\n");
    },
    cancel() {
      stop();
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
