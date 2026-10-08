"use client";

import {
  AlertTriangle,
  Download,
  ExternalLink,
  File,
  FileArchive,
  FileSpreadsheet,
  FileText,
  ImageOff,
  Loader2,
  Mic,
  Music,
  Presentation,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  formatMediaBytes,
  formatMediaDuration,
  inlineMediaKind,
  MEDIA_SIZE_LIMIT_BYTES,
  MESSAGE_MEDIA_TYPE_LABELS,
} from "@support-automation/shared";
import { useProjectHref } from "@/components/ProjectLink";
import type { ThreadMedia } from "@/server/chatInbox";

/**
 * One WhatsApp attachment inside a chat bubble (MEDIA_STORAGE.md).
 *
 * The thread carries only metadata; every file is fetched from the authorised media endpoint, and
 * only when it is about to be seen: images load lazily as they scroll near, and video and audio
 * load nothing at all until somebody presses play (`preload="none"`). Opening a busy group never
 * downloads its whole media history.
 *
 * Every state has words. A file that is still being stored, was never stored, failed, or was
 * removed by retention says which — never a broken-image icon with no explanation.
 */

const TYPE_NOUN: Record<ThreadMedia["type"], string> = {
  IMAGE: "Image",
  VIDEO: "Video",
  AUDIO: "Audio",
  DOCUMENT: "Document",
  STICKER: "Sticker",
  GIF: "GIF",
  OTHER: "File",
};

const dateFormat = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric" });

/** Media surfaces are tinted from the bubble's own text colour, so they read on both bubble colours. */
const SURFACE = "bg-[color-mix(in_oklab,currentColor_7%,transparent)]";
const SOFT_TEXT = "text-[color-mix(in_oklab,currentColor_70%,transparent)]";

function noun(media: ThreadMedia): string {
  return media.waType === "ptt" ? "Voice message" : TYPE_NOUN[media.type];
}

/** An icon for the kind of file, read from its name and MIME type. */
function DocumentIcon({ media }: { media: ThreadMedia }) {
  const name = (media.fileName ?? "").toLowerCase();
  const mime = (media.mimeType ?? "").toLowerCase();
  const props = { className: "size-[18px]", "aria-hidden": true } as const;
  if (mime === "application/pdf" || name.endsWith(".pdf") || mime.startsWith("text/")) return <FileText {...props} />;
  if (/sheet|excel|csv/.test(mime) || /\.(xlsx?|csv)$/.test(name)) return <FileSpreadsheet {...props} />;
  if (/presentation|powerpoint/.test(mime) || /\.pptx?$/.test(name)) return <Presentation {...props} />;
  if (/zip|rar|7z|tar|gzip|compressed/.test(mime) || /\.(zip|rar|7z|tar|gz)$/.test(name)) return <FileArchive {...props} />;
  if (mime.startsWith("audio/")) return <Music {...props} />;
  return <File {...props} />;
}

/** "PDF", "XLSX", "ZIP" — from the file name, else the MIME subtype. Never guessed beyond that. */
function fileKind(media: ThreadMedia): string | null {
  const ext = /\.([a-z0-9]{1,6})$/i.exec(media.fileName ?? "")?.[1];
  if (ext) return ext.toUpperCase();
  const sub = (media.mimeType ?? "").split(";")[0]!.split("/")[1];
  return sub && sub.length <= 12 ? sub.toUpperCase() : null;
}

function StatusBox({ icon, title, detail, busy = false }: { icon: ReactNode; title: string; detail?: string | null; busy?: boolean }) {
  return (
    <div className={`flex min-w-[14rem] max-w-[18rem] items-start gap-2.5 rounded-[var(--radius-md)] ${SURFACE} px-3 py-2.5`} role={busy ? "status" : undefined}>
      <span className={`mt-0.5 shrink-0 ${SOFT_TEXT}`}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[12px] font-medium leading-snug">{title}</span>
        {detail ? <span className={`mt-0.5 block text-[11px] leading-snug ${SOFT_TEXT}`}>{detail}</span> : null}
      </span>
    </div>
  );
}

function unavailableDetail(media: ThreadMedia): { title: string; detail: string } {
  // "this video", "this voice message" — but "this GIF", which is an acronym.
  const what = media.type === "GIF" ? "GIF" : noun(media).toLowerCase();
  const size = media.sizeBytes ? ` (${formatMediaBytes(media.sizeBytes)})` : "";
  switch (media.status) {
    case "NOT_STORED":
      if (media.statusReason === "SETTING_OFF") {
        return { title: "Media was not stored", detail: `${MESSAGE_MEDIA_TYPE_LABELS[media.type]} storage was switched off when this ${what} arrived.` };
      }
      if (media.statusReason === "TOO_LARGE") {
        return { title: "Media was not stored", detail: `This ${what}${size} is over the ${formatMediaBytes(MEDIA_SIZE_LIMIT_BYTES[media.type])} limit for its type.` };
      }
      return { title: "Media was not stored", detail: "WhatsApp did not provide this file." };
    case "FAILED":
      if (media.statusReason === "EXPIRED") return { title: "Media unavailable", detail: "It could not be archived: WhatsApp no longer has this file." };
      if (media.statusReason === "NO_DOWNLOAD_INFO") return { title: "Media unavailable", detail: "It could not be archived: WhatsApp did not provide the file." };
      return { title: "Media unavailable", detail: "It could not be archived after several tries." };
    case "DELETED":
      return {
        title: "Media removed",
        detail: `${media.statusReason === "RETENTION" ? "Removed by media retention" : "Removed by a media cleanup"}${media.deletedAt ? ` on ${dateFormat.format(new Date(media.deletedAt))}` : ""}. The message itself is kept.`,
      };
    default:
      return { title: "Media unavailable", detail: "" };
  }
}

function Lightbox({ src, alt, downloadHref, openHref, onClose }: { src: string; alt: string; downloadHref: string; openHref: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (node && !node.open) node.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={alt}
      className="m-0 h-dvh max-h-none w-dvw max-w-none bg-black/90 p-0 backdrop:bg-black/60"
    >
      <div className="flex h-full flex-col" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="flex shrink-0 items-center justify-end gap-1 p-3">
          <a href={openHref} target="_blank" rel="noopener" className="rounded-[var(--radius-md)] p-2 text-white/80 hover:bg-white/10 hover:text-white" title="Open in a new tab">
            <ExternalLink className="size-4" aria-hidden />
            <span className="sr-only">Open in a new tab</span>
          </a>
          <a href={downloadHref} className="rounded-[var(--radius-md)] p-2 text-white/80 hover:bg-white/10 hover:text-white" title="Download">
            <Download className="size-4" aria-hidden />
            <span className="sr-only">Download</span>
          </a>
          <button type="button" onClick={onClose} className="rounded-[var(--radius-md)] p-2 text-white/80 hover:bg-white/10 hover:text-white" title="Close">
            <X className="size-5" aria-hidden />
            <span className="sr-only">Close</span>
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 pb-6" onClick={(e) => e.target === e.currentTarget && onClose()}>
          {/* eslint-disable-next-line @next/next/no-img-element -- an authorised, streamed original; next/image would proxy and re-encode it */}
          <img src={src} alt={alt} className="max-h-full max-w-full object-contain" />
        </div>
      </div>
    </dialog>
  );
}

export function MessageAttachment({ media }: { media: ThreadMedia }) {
  const toProject = useProjectHref();
  const [lightbox, setLightbox] = useState(false);
  const [broken, setBroken] = useState(false);
  const base = toProject(`/api/whatsapp/media/${encodeURIComponent(media.id)}`);
  const src = base;
  const thumb = media.hasThumbnail ? `${base}?variant=thumbnail` : undefined;
  const downloadHref = `${base}?download=1`;

  if (media.status === "PENDING" || media.status === "DOWNLOADING") {
    return (
      <StatusBox
        busy
        icon={<Loader2 className="size-4 animate-spin" aria-hidden />}
        title="Media is being stored…"
        detail={[noun(media), media.sizeBytes ? formatMediaBytes(media.sizeBytes) : null].filter(Boolean).join(" · ")}
      />
    );
  }
  if (media.status !== "STORED") {
    const { title, detail } = unavailableDetail(media);
    return <StatusBox icon={media.status === "FAILED" ? <AlertTriangle className="size-4" aria-hidden /> : <ImageOff className="size-4" aria-hidden />} title={title} detail={detail} />;
  }
  if (broken) {
    return <StatusBox icon={<AlertTriangle className="size-4" aria-hidden />} title="Media unavailable" detail="The stored file could not be loaded. Try again later, or download it." />;
  }

  const ratio = media.width && media.height ? `${media.width} / ${media.height}` : undefined;
  const meta = [noun(media), formatMediaDuration(media.durationSeconds), media.sizeBytes ? formatMediaBytes(media.sizeBytes) : null].filter(Boolean).join(" · ");

  if (media.type === "IMAGE" || media.type === "STICKER") {
    const isSticker = media.type === "STICKER";
    return (
      <>
        <button
          type="button"
          onClick={() => setLightbox(true)}
          className={`group/media relative block overflow-hidden rounded-[var(--radius-md)] focus-visible:outline-2 focus-visible:outline-offset-2 ${
            isSticker ? "w-[9rem]" : `w-[min(17rem,62vw)] ${SURFACE}`
          }`}
          style={{ aspectRatio: ratio ?? (isSticker ? "1 / 1" : "4 / 3"), backgroundImage: thumb ? `url("${thumb}")` : undefined, backgroundSize: "cover" }}
          title="View full size"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- authorised original, lazy so a long thread only loads what is near the screen */}
          <img
            src={src}
            alt={isSticker ? "Sticker" : "Image"}
            loading="lazy"
            decoding="async"
            onError={() => setBroken(true)}
            className={`size-full ${isSticker ? "object-contain" : "object-cover"} transition-transform duration-[var(--duration-base)] group-hover/media:scale-[1.015]`}
          />
        </button>
        {lightbox ? <Lightbox src={src} alt={noun(media)} downloadHref={downloadHref} openHref={src} onClose={() => setLightbox(false)} /> : null}
      </>
    );
  }

  if (media.type === "VIDEO" || media.type === "GIF") {
    const isGif = media.type === "GIF";
    return (
      <div className="w-[min(17rem,62vw)]">
        <video
          controls
          preload="none"
          playsInline
          loop={isGif}
          muted={isGif}
          poster={thumb}
          onError={() => setBroken(true)}
          className="block w-full rounded-[var(--radius-md)] bg-black"
          style={{ aspectRatio: ratio ?? "16 / 9" }}
        >
          <source src={src} type={(media.mimeType ?? "video/mp4").split(";")[0]} />
        </video>
        <div className={`mt-1 flex items-center justify-between gap-2 px-0.5 text-[11px] ${SOFT_TEXT}`}>
          <span className="tabular">{meta}</span>
          <a href={downloadHref} className="inline-flex items-center gap-1 hover:underline">
            <Download className="size-3" aria-hidden />
            Download
          </a>
        </div>
      </div>
    );
  }

  if (media.type === "AUDIO") {
    return (
      <div className={`w-[min(18rem,66vw)] rounded-[var(--radius-md)] ${SURFACE} px-2.5 py-2`}>
        <div className={`mb-1.5 flex items-center gap-1.5 text-[11px] ${SOFT_TEXT}`}>
          {media.waType === "ptt" ? <Mic className="size-3.5" aria-hidden /> : <Music className="size-3.5" aria-hidden />}
          <span className="tabular">{meta}</span>
        </div>
        <audio controls preload="none" src={src} onError={() => setBroken(true)} className="h-9 w-full" />
      </div>
    );
  }

  // Documents and every other file: a card, never rendered — opened in the browser only when the
  // browser itself can show it safely (PDF, image, video, audio), downloaded otherwise.
  const canOpen = inlineMediaKind(media.mimeType) !== null;
  const kind = fileKind(media);
  return (
    <div className={`flex w-[min(18rem,66vw)] items-center gap-3 rounded-[var(--radius-md)] ${SURFACE} px-3 py-2.5`}>
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] ${SURFACE}`}>
        <DocumentIcon media={media} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium" title={media.fileName ?? undefined}>
          {media.fileName ?? `${TYPE_NOUN[media.type]} attachment`}
        </span>
        <span className={`block text-[11px] ${SOFT_TEXT} tabular`}>{[kind, media.sizeBytes ? formatMediaBytes(media.sizeBytes) : null].filter(Boolean).join(" · ")}</span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        {canOpen ? (
          <a href={src} target="_blank" rel="noopener" className="rounded-[var(--radius-sm)] p-1.5 hover:bg-[color-mix(in_oklab,currentColor_12%,transparent)]" title="Open">
            <ExternalLink className="size-4" aria-hidden />
            <span className="sr-only">Open</span>
          </a>
        ) : null}
        <a href={downloadHref} className="rounded-[var(--radius-sm)] p-1.5 hover:bg-[color-mix(in_oklab,currentColor_12%,transparent)]" title="Download">
          <Download className="size-4" aria-hidden />
          <span className="sr-only">Download</span>
        </a>
      </span>
    </div>
  );
}

/** A message that carried a file before media storage existed: there is no file to show, and it says so. */
export function MediaNotArchived({ body }: { body: string }) {
  const label = /^\[([^\]]+)\]/.exec(body.trim())?.[1] ?? "Media";
  return <StatusBox icon={<ImageOff className="size-4" aria-hidden />} title={`${label} not archived`} detail="This arrived before media storage was switched on, so only the message text was kept." />;
}
