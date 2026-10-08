/**
 * Shapes returned by the Softify Forge REST API (https://forge.softifybd.com/api/v1).
 *
 * Only the read endpoints this application actually uses are modelled. Forge also exposes task,
 * daily-log, kudos and notification endpoints — deliberately not typed here, because this app is a
 * customer-support system and has no business writing to a developer's task board. If a later
 * phase wants that, it is additive.
 */

export interface ForgeClientConfig {
  apiKey: string;
  /** Base URL including `/api/v1`, no trailing slash. */
  apiUrl: string;
}

export interface ForgeIdentity {
  apiVersion: string;
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface ForgeProject {
  id: string;
  name: string;
  active: boolean;
  gitlab: boolean;
  /** True when this project reached us through a read-only grant rather than membership. */
  readonly?: boolean;
}

export interface ForgeRepoRef {
  gitlabProjectId: string;
  label: string;
  primary: boolean;
}

export interface ForgeTreeEntry {
  name: string;
  /** `tree` is a directory, `blob` is a file. */
  type: "tree" | "blob";
  path: string;
}

export interface ForgeTree {
  ref: string;
  path: string;
  repo: ForgeRepoRef | null;
  repos: ForgeRepoRef[];
  entries: ForgeTreeEntry[];
}

/**
 * `kind` is the important field: Forge refuses to inline binaries and very large blobs, and says
 * so rather than returning a truncated string. Callers must check it instead of assuming
 * `content` is present.
 */
export interface ForgeFile {
  path: string;
  ref: string;
  kind: "text" | "binary" | "too_large";
  content: string | null;
}

/**
 * A Forge "module" is the unit this integration cares most about: a named product area with the
 * repository paths that implement it. It is the map that lets the knowledge builder read the right
 * few files for "how does billing work" instead of walking an enormous repository.
 */
export interface ForgeKnowledgeModule {
  id: string;
  name: string;
  slug: string;
  summary: string | null;
  sourcePaths: string[];
  confidence: number | null;
}

/**
 * Note there is no `body`. Forge's article list is a catalogue — title, module and confidence only
 * — so articles are useful for knowing WHAT is documented, never as content to republish. The
 * bodies this app teaches its AI from come from the repository's own files.
 */
export interface ForgeKnowledgeArticle {
  id: string;
  title: string;
  moduleId: string | null;
  sourceRef: string | null;
  confidence: number | null;
  status: string;
}
