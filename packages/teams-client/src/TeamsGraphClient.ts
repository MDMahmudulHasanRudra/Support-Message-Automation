import type { TeamsGraphChannel, TeamsGraphMessage, TeamsGraphTeam, TeamsGraphUser } from "./types.js";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const REQUEST_TIMEOUT_MS = 20_000;
/** Hard ceiling on @odata.nextLink pagination per call — a polling sync tick must never turn into
 * an unbounded fetch loop against a channel with years of history. Later pages are simply picked
 * up by the next sync tick. */
const MAX_PAGES = 5;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

interface GraphListResponse<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

interface GraphChatMessage {
  id: string;
  replyToId: string | null;
  from: { user?: { id: string; displayName: string } } | null;
  body: { contentType: string; content: string };
  createdDateTime: string;
}

/**
 * Thin wrapper around the Microsoft Graph REST API (learn.microsoft.com/graph) — plain fetch
 * calls, no SDK, for the same reason TeamsAuthClient avoids @azure/msal-node (see its doc
 * comment): keeps this package dependency-free and every call's shape fully explicit. Constructed
 * fresh per call site with a valid (already-refreshed) access token — this class never refreshes
 * a token itself, that's TeamsAuthClient's job, kept separate so callers control exactly when a
 * refresh happens (see apps/worker/src/teams/tokenRefresh.ts).
 */
export class TeamsGraphClient {
  constructor(private readonly accessToken: string) {}

  private async get<T>(path: string): Promise<T> {
    const response = await fetchWithTimeout(`${GRAPH_BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Microsoft Graph ${path} returned ${response.status}: ${text.slice(0, 500)}`);
    }
    return response.json() as Promise<T>;
  }

  private async getAllPages<T>(initialPath: string): Promise<T[]> {
    const results: T[] = [];
    let path: string | undefined = initialPath;
    let page = 0;
    while (path && page < MAX_PAGES) {
      const response: GraphListResponse<T> = path.startsWith("http")
        ? await (async () => {
            const res = await fetchWithTimeout(path as string, { headers: { Authorization: `Bearer ${this.accessToken}` } });
            if (!res.ok) throw new Error(`Microsoft Graph pagination request returned ${res.status}`);
            return res.json() as Promise<GraphListResponse<T>>;
          })()
        : await this.get<GraphListResponse<T>>(path);
      results.push(...response.value);
      path = response["@odata.nextLink"];
      page += 1;
    }
    return results;
  }

  async getCurrentUser(): Promise<TeamsGraphUser> {
    return this.get<TeamsGraphUser>("/me");
  }

  async listJoinedTeams(): Promise<TeamsGraphTeam[]> {
    return this.getAllPages<TeamsGraphTeam>("/me/joinedTeams?$select=id,displayName");
  }

  async listChannels(teamId: string): Promise<TeamsGraphChannel[]> {
    return this.getAllPages<TeamsGraphChannel>(`/teams/${teamId}/channels?$select=id,displayName,membershipType`);
  }

  async listChannelMessages(teamId: string, channelId: string): Promise<TeamsGraphMessage[]> {
    const raw = await this.getAllPages<GraphChatMessage>(`/teams/${teamId}/channels/${channelId}/messages`);
    return raw.map(mapMessage);
  }

  async listMessageReplies(teamId: string, channelId: string, messageId: string): Promise<TeamsGraphMessage[]> {
    const raw = await this.getAllPages<GraphChatMessage>(`/teams/${teamId}/channels/${channelId}/messages/${messageId}/replies`);
    return raw.map(mapMessage);
  }
}

function mapMessage(raw: GraphChatMessage): TeamsGraphMessage {
  return {
    id: raw.id,
    replyToId: raw.replyToId,
    from: raw.from?.user ? { userId: raw.from.user.id, displayName: raw.from.user.displayName } : null,
    body: raw.body.contentType === "html" ? stripHtml(raw.body.content) : raw.body.content,
    createdDateTime: raw.createdDateTime,
  };
}
