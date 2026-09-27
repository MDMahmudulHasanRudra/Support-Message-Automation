import type {
  ForgeClientConfig,
  ForgeFile,
  ForgeIdentity,
  ForgeKnowledgeArticle,
  ForgeKnowledgeModule,
  ForgeProject,
  ForgeTree,
} from "./types.js";

/**
 * Read-only client for the Softify Forge REST API, written with plain `fetch`: the surface used
 * here is a handful of GETs, and a dependency would cost more in supply chain and build weight than it saves in code.
 *
 * **This client is deliberately read-only.** Forge can create tasks, post comments and submit
 * daily logs; none of that is exposed here. A customer-support system that can silently write to
 * the engineering team's board is a liability, and leaving the methods unwritten is a stronger
 * guarantee than a policy saying not to call them.
 */
export class ForgeClient {
  private readonly apiKey: string;
  private readonly apiUrl: string;

  constructor(config: ForgeClientConfig) {
    this.apiKey = config.apiKey;
    this.apiUrl = config.apiUrl.replace(/\/+$/, "");
  }

  /**
   * `timeoutMs` is generous because a repository tree listing goes Forge → GitLab → back; the
   * observed worst case while building this was several seconds on a large directory.
   */
  private async get<T>(path: string, params: Record<string, string | undefined> = {}, timeoutMs = 45_000): Promise<T> {
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      const reason = (err as Error).name === "AbortError" ? `timed out after ${timeoutMs}ms` : (err as Error).message;
      throw new ForgeRequestError(`Forge request failed (${reason}).`, null, path);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // 403/404 are a scope boundary, not a fault — the guide is explicit that a key may be
      // project-scoped and that callers should treat those as "not yours", not retry them.
      throw new ForgeRequestError(
        response.status === 403 || response.status === 404
          ? `Forge denied access (HTTP ${response.status}). This key is not in scope for that resource.`
          : `Forge returned HTTP ${response.status}.`,
        response.status,
        path,
      );
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A Forge route that does not exist serves the SPA's HTML with a 200, so a parse failure
      // here means "wrong path", not "Forge is broken". Say that.
      throw new ForgeRequestError("Forge returned a non-JSON response — the endpoint may not exist.", response.status, path);
    }

    // Some endpoints answer 200 with an { error } envelope (GitLab passthrough failures do this).
    const envelope = parsed as { error?: string };
    if (envelope && typeof envelope === "object" && typeof envelope.error === "string") {
      throw new ForgeRequestError(`Forge could not read that resource: ${envelope.error}`, response.status, path);
    }
    return parsed as T;
  }

  /** Also the cheapest liveness/credential check — used by the dashboard's "Test connection". */
  getIdentity(): Promise<ForgeIdentity> {
    return this.get<ForgeIdentity>("/me");
  }

  async listProjects(): Promise<ForgeProject[]> {
    const data = await this.get<{ projects?: ForgeProject[] }>("/projects");
    return data.projects ?? [];
  }

  /** `path` omitted lists the repository root; `repo` omitted uses the project's primary repo. */
  getTree(projectId: string, path?: string, repo?: string, ref?: string): Promise<ForgeTree> {
    return this.get<ForgeTree>(`/projects/${projectId}/tree`, { path, repo, ref });
  }

  getFile(projectId: string, path: string, repo?: string, ref?: string): Promise<ForgeFile> {
    // 60s: a single large source file has been slower than a directory listing in practice.
    return this.get<ForgeFile>(`/projects/${projectId}/file`, { path, repo, ref }, 60_000);
  }

  async listKnowledgeModules(projectId: string): Promise<ForgeKnowledgeModule[]> {
    const data = await this.get<{ modules?: ForgeKnowledgeModule[] }>(`/projects/${projectId}/knowledge/modules`);
    return data.modules ?? [];
  }

  async listKnowledgeArticles(projectId: string): Promise<ForgeKnowledgeArticle[]> {
    const data = await this.get<{ articles?: ForgeKnowledgeArticle[] }>(`/projects/${projectId}/knowledge/articles`);
    return data.articles ?? [];
  }
}

export class ForgeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly path: string,
  ) {
    super(message);
    this.name = "ForgeRequestError";
  }

  /** A scope boundary the caller should skip past, rather than a failure worth retrying. */
  get isOutOfScope(): boolean {
    return this.status === 403 || this.status === 404;
  }
}
