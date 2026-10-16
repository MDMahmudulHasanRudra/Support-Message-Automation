"use client";

import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from "lucide-react";
import { useCallback, useEffect, useRef, type TouchEvent as ReactTouchEvent } from "react";
import { useProjectHref } from "@/components/ProjectLink";

/**
 * Every stored image of the loaded conversation in one viewer, with previous / next and the arrow
 * keys — the way a WhatsApp chat's media opens. Each image is still fetched from the authorised media
 * endpoint (MEDIA_STORAGE.md), only when it is shown; nothing here makes a file public or loads the
 * conversation's images in advance.
 */
export interface GalleryImage {
  mediaId: string;
  alt: string;
}

export function GalleryLightbox({ images, index, onIndex, onClose }: { images: GalleryImage[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const toProject = useProjectHref();
  const image = images[index];
  const step = useCallback((delta: number) => onIndex(Math.min(images.length - 1, Math.max(0, index + delta))), [images.length, index, onIndex]);

  useEffect(() => {
    const node = ref.current;
    if (node && !node.open) node.showModal();
    return () => node?.close();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step]);

  // A horizontal swipe steps through the images (a mostly-vertical one is the browser's own scroll).
  const onTouchStart = (event: ReactTouchEvent) => {
    const touch = event.touches.length === 1 ? event.touches[0]! : null;
    swipeStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchEnd = (event: ReactTouchEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  };

  if (!image) return null;
  const src = toProject(`/api/whatsapp/media/${encodeURIComponent(image.mediaId)}`);
  // On a touch screen the arrows give way to swiping (and stay for a screen reader); with a mouse they show.
  const nav = "rounded-full bg-white/10 p-2 text-white/90 hover:bg-white/20 disabled:opacity-30 [@media(pointer:coarse)]:sr-only";

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-label={`${image.alt}, ${index + 1} of ${images.length}`}
      className="m-0 h-dvh max-h-none w-dvw max-w-none bg-black/90 p-0 backdrop:bg-black/60"
    >
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center justify-between gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-white/80">
          <span className="text-[12px] tabular" aria-live="polite">
            {index + 1} of {images.length}
          </span>
          <span className="flex items-center gap-1">
            <a href={src} target="_blank" rel="noopener" className="flex size-11 items-center justify-center rounded-[var(--radius-md)] hover:bg-white/10 hover:text-white sm:size-9" title="Open in a new tab">
              <ExternalLink className="size-4" aria-hidden />
              <span className="sr-only">Open in a new tab</span>
            </a>
            <a href={`${src}?download=1`} className="flex size-11 items-center justify-center rounded-[var(--radius-md)] hover:bg-white/10 hover:text-white sm:size-9" title="Download">
              <Download className="size-4" aria-hidden />
              <span className="sr-only">Download</span>
            </a>
            <button type="button" onClick={onClose} className="flex size-11 items-center justify-center rounded-[var(--radius-md)] hover:bg-white/10 hover:text-white sm:size-9" title="Close">
              <X className="size-5" aria-hidden />
              <span className="sr-only">Close</span>
            </button>
          </span>
        </div>
        <div
          className="flex min-h-0 flex-1 touch-pan-y items-center justify-center gap-2 px-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-4"
          onClick={(e) => e.target === e.currentTarget && onClose()}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          <button type="button" onClick={() => step(-1)} disabled={index === 0} className={nav} aria-label="Previous image">
            <ChevronLeft className="size-5" aria-hidden />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element -- an authorised, streamed original; next/image would proxy and re-encode it */}
          <img key={image.mediaId} src={src} alt={image.alt} className="max-h-full min-w-0 max-w-full flex-1 object-contain" />
          <button type="button" onClick={() => step(1)} disabled={index === images.length - 1} className={nav} aria-label="Next image">
            <ChevronRight className="size-5" aria-hidden />
          </button>
        </div>
      </div>
    </dialog>
  );
}
