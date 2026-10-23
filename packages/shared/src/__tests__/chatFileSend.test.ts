import { describe, expect, it } from "vitest";
import {
  buildOutgoingFileKey,
  OUTGOING_FILE_LIMITS,
  outgoingFileSummary,
  planOutgoingFile,
  sanitizeFileName,
  validateOutgoingFileContent,
} from "../chatFileSend.js";

const pad = (bytes: number[] | string, length = 64): Uint8Array => {
  const head = typeof bytes === "string" ? Array.from(bytes, (c) => c.charCodeAt(0)) : bytes;
  const out = new Uint8Array(length);
  out.set(head.slice(0, length));
  return out;
};
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP4 = pad("\0\0\0\x20ftypisom");
const PDF = pad("%PDF-1.7");
const ZIP = pad([0x50, 0x4b, 0x03, 0x04]);
const EXE = pad([0x4d, 0x5a, 0x90, 0x00]);
const ELF = pad([0x7f, 0x45, 0x4c, 0x46]);
const MP3 = pad("ID3\x04");
const oggWith = (codec: string) => {
  const head = pad("OggS");
  head.set(Array.from(codec, (c) => c.charCodeAt(0)), 28);
  return head;
};

const plan = (head: Uint8Array, fileName: string, mode: "AUTO" | "DOCUMENT" | "VOICE" = "AUTO", size = 1000) => planOutgoingFile({ head, fileName, size, mode });

describe("planOutgoingFile — the type comes from the bytes", () => {
  it("sends photos, videos, audio and documents in their natural form", () => {
    expect(plan(JPEG, "a.jpg")).toMatchObject({ ok: true, kind: "IMAGE", mimeType: "image/jpeg", fileName: "a.jpg" });
    expect(plan(PNG, "b.png")).toMatchObject({ ok: true, kind: "IMAGE", mimeType: "image/png" });
    expect(plan(MP4, "c.mp4")).toMatchObject({ ok: true, kind: "VIDEO", mimeType: "video/mp4" });
    expect(plan(MP3, "d.mp3")).toMatchObject({ ok: true, kind: "AUDIO", mimeType: "audio/mpeg" });
    expect(plan(PDF, "e.pdf")).toMatchObject({ ok: true, kind: "DOCUMENT", mimeType: "application/pdf" });
    expect(plan(ZIP, "f.docx")).toMatchObject({ ok: true, kind: "DOCUMENT", mimeType: expect.stringContaining("wordprocessingml") });
  });

  it("never trusts the name: a JPEG called .pdf goes as a JPEG, with its real extension added", () => {
    expect(plan(JPEG, "invoice.pdf")).toMatchObject({ ok: true, kind: "IMAGE", mimeType: "image/jpeg", fileName: "invoice.pdf.jpg" });
  });

  it("refuses programs whatever they are called", () => {
    expect(plan(EXE, "report.pdf").ok).toBe(false);
    expect(plan(ELF, "photo.jpg").ok).toBe(false);
    expect(plan(pad("#!/bin/sh\nrm"), "notes.txt").ok).toBe(false);
    expect(plan(PDF, "setup.exe").ok).toBe(false);
    expect(plan(pad("<html>"), "page.html").ok).toBe(false);
    expect(plan(pad("<svg"), "logo.svg").ok).toBe(false);
  });

  it("refuses a type it cannot recognise and an empty file", () => {
    expect(plan(pad("random bytes"), "thing.bin").ok).toBe(false);
    expect(plan(JPEG, "a.jpg", "AUTO", 0).ok).toBe(false);
  });

  it("applies the per-kind size limits", () => {
    expect(plan(JPEG, "a.jpg", "AUTO", OUTGOING_FILE_LIMITS.IMAGE).ok).toBe(true);
    expect(plan(JPEG, "a.jpg", "AUTO", OUTGOING_FILE_LIMITS.IMAGE + 1).ok).toBe(false);
    // The same large photo is fine as a document, whose ceiling is higher.
    expect(plan(JPEG, "a.jpg", "DOCUMENT", OUTGOING_FILE_LIMITS.IMAGE + 1)).toMatchObject({ ok: true, kind: "DOCUMENT" });
    expect(plan(PDF, "a.pdf", "AUTO", OUTGOING_FILE_LIMITS.DOCUMENT + 1).ok).toBe(false);
  });

  it("sends a voice note only for Opus audio", () => {
    expect(plan(oggWith("OpusHead"), "v.ogg", "VOICE")).toMatchObject({ ok: true, kind: "VOICE", mimeType: "audio/ogg" });
    expect(plan(oggWith("\x01vorbis"), "v.ogg", "VOICE").ok).toBe(false);
    expect(plan(MP3, "v.mp3", "VOICE").ok).toBe(false);
  });

  it("lets anything sendable go as a document", () => {
    expect(plan(MP4, "c.mp4", "DOCUMENT")).toMatchObject({ ok: true, kind: "DOCUMENT", mimeType: "video/mp4" });
  });
});

describe("sanitizeFileName", () => {
  it("drops paths and control characters", () => {
    expect(sanitizeFileName("../../etc/passwd", "bin")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\a\\bill<1>.pdf", "pdf")).toBe("bill1.pdf");
    expect(sanitizeFileName("..", "pdf")).toBe("file.pdf");
    expect(sanitizeFileName("a\u0000b.pdf", "pdf")).toBe("ab.pdf");
  });
});

describe("validateOutgoingFileContent — the worker's re-check", () => {
  const good = { storageKey: "outbound/p1/acc/2026/10/x", fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1000, kind: "IMAGE", caption: "hi" };

  it("accepts what the route queues", () => {
    expect(validateOutgoingFileContent(good, "p1")).toMatchObject({ ok: true });
  });

  it("refuses another project's file, traversal, an unknown kind, a bad name or an oversize file", () => {
    expect(validateOutgoingFileContent({ ...good, storageKey: "outbound/p2/acc/2026/10/x" }, "p1").ok).toBe(false);
    expect(validateOutgoingFileContent({ ...good, storageKey: "whatsapp/p1/acc/x" }, "p1").ok).toBe(false);
    expect(validateOutgoingFileContent({ ...good, storageKey: "outbound/p1/../p2/x" }, "p1").ok).toBe(false);
    expect(validateOutgoingFileContent({ ...good, kind: "STICKER" }, "p1").ok).toBe(false);
    expect(validateOutgoingFileContent({ ...good, fileName: "a.exe" }, "p1").ok).toBe(false);
    expect(validateOutgoingFileContent({ ...good, fileName: "../a.jpg" }, "p1").ok).toBe(false);
    expect(validateOutgoingFileContent({ ...good, sizeBytes: OUTGOING_FILE_LIMITS.IMAGE + 1 }, "p1").ok).toBe(false);
    expect(validateOutgoingFileContent(null, "p1").ok).toBe(false);
  });
});

describe("summaries and keys", () => {
  it("summarises a queued file", () => {
    expect(outgoingFileSummary("IMAGE", "a.jpg", "")).toBe("[Photo]");
    expect(outgoingFileSummary("IMAGE", "a.jpg", "Your bill")).toBe("[Photo] Your bill");
    expect(outgoingFileSummary("DOCUMENT", "bill.pdf", "")).toBe("[Document] bill.pdf");
  });

  it("builds an id-only key under the project", () => {
    expect(buildOutgoingFileKey({ projectId: "p1", accountId: "a1", id: "u1", createdAt: new Date(Date.UTC(2026, 0, 5)) })).toBe("outbound/p1/a1/2026/01/u1");
  });
});
