import { createHash } from "node:crypto";

/**
 * Content fingerprints, for integrity and duplicate detection.
 *
 * **A hash is not encryption.** Nothing here protects confidentiality: a fingerprint tells you
 * whether two pieces of content are the same and whether one has changed since you last looked. It
 * is stored beside the plaintext it describes, which would be pointless if it were meant to hide
 * anything. Every use of it in this codebase is one of:
 *
 *   - "has this document already been imported?"
 *   - "has this entry been modified since it was verified?"
 *   - "did these two AI replies see the same evidence?"
 *
 * SHA-256 because it is the boring correct choice: available in Node's standard library, no
 * dependency, no tuning, and collision resistance far beyond what distinguishing a few thousand
 * knowledge entries requires. Nothing here is a password — password hashing is a different problem
 * with different requirements, and this must never be used for one.
 *
 * **Canonicalisation is the part that actually matters.** A hash is only useful if the same content
 * always produces the same digest, so the input has to be normalised before hashing: fields in a
 * fixed order, whitespace collapsed, a null and an empty string treated alike. Get that wrong and
 * the hash changes when nothing did, which is worse than having no hash — it reports modification
 * that never happened.
 *
 * Volatile fields are excluded on purpose. `updatedAt` changes on every write, `status` changes
 * when somebody archives an entry, `humanVerified` changes on approval — none of those change what
 * the entry SAYS, and including them would make "has the content changed?" unanswerable.
 */

/** Separator between fields. A control character, so it cannot occur inside the values themselves. */
const FIELD_SEPARATOR = "";

/**
 * Collapses one field to its comparable form: unicode-normalised, whitespace-squeezed, trimmed.
 *
 * NFC so that two byte sequences rendering the same Bengali word hash the same — the same
 * normalisation `normalizeText` applies for matching, and for the same reason. Deliberately NOT
 * lowercased: case is part of what an entry says, and folding it would report two genuinely
 * different titles as identical content.
 */
function canonicaliseField(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * The canonical string form of an ordered list of named fields.
 *
 * Exported so a caller can assert what is being hashed rather than infer it from a digest, and so
 * a test can show that two inputs canonicalise identically.
 */
export function canonicalise(fields: ReadonlyArray<string | null | undefined>): string {
  return fields.map(canonicaliseField).join(FIELD_SEPARATOR);
}

/** SHA-256 of the canonical form, hex-encoded. */
export function contentFingerprint(fields: ReadonlyArray<string | null | undefined>): string {
  return createHash("sha256").update(canonicalise(fields), "utf8").digest("hex");
}

/** The factual content of a knowledge entry — what it SAYS, not what state its row is in. */
export interface HashableKnowledge {
  title: string;
  question?: string | null;
  answer: string;
  procedure?: string | null;
  module?: string | null;
}

/**
 * The fingerprint of a knowledge entry's content.
 *
 * Field order is fixed and must never be reordered: doing so changes every existing hash and would
 * report the entire knowledge base as modified. Adding a field to the end is safe in the same sense
 * — old hashes stop matching — so a change here is a backfill, not an edit.
 */
export function knowledgeContentHash(entry: HashableKnowledge): string {
  return contentFingerprint([entry.title, entry.question, entry.answer, entry.procedure, entry.module]);
}

/** One piece of evidence, identified by what it was at the moment it was used. */
export interface EvidenceFingerprintInput {
  /** Ordered exactly as the bundle presented them — position is part of the evidence. */
  items: ReadonlyArray<{ id: string; version: number }>;
  questionShape: string;
  missingProcedure: boolean;
  workflowCount: number;
}

/**
 * The fingerprint of an assembled evidence bundle.
 *
 * Two AI replies share a fingerprint exactly when they were built on the same evidence, in the same
 * order, with the same structural conclusions drawn from it. That is what makes model comparison
 * meaningful: a difference in output across two models is attributable to the models only if this
 * is identical, and it is what lets "explain this answer" reconstruct the inputs six months later.
 *
 * Order is significant and deliberately not sorted away. The bundle is ranked, the prompt renders
 * it ranked, and the model reads the first entry most closely — so two bundles holding the same
 * entries in a different order genuinely are different evidence.
 *
 * The question itself is NOT part of this. The fingerprint identifies the EVIDENCE, so that the
 * same evidence assembled for two differently-worded questions is recognisably the same evidence;
 * the question is reachable through the decision's own message.
 */
export function evidenceFingerprint(input: EvidenceFingerprintInput): string {
  return contentFingerprint([
    ...input.items.map((item) => `${item.id}@${item.version}`),
    input.questionShape,
    input.missingProcedure ? "missing-procedure" : "has-procedure",
    String(input.workflowCount),
  ]);
}
