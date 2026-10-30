"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import { useProjectHref, useProjectRouter } from "@/components/ProjectLink";
import { Alert, Button, Input } from "@/components/ui";
import { deleteSocialAssetAction, updateSocialAssetAction, type SocialActionState } from "@/server/actions/social";
import type { SocialAssetView } from "@/server/social/media";
import { formatBytes } from "../socialUi";

/** Upload, browse, describe and delete library files. Uploads go to the project's own checked route. */
export function MediaLibrary({ assets, canEdit, folder }: { assets: SocialAssetView[]; canEdit: boolean; folder: string }) {
  const router = useProjectRouter();
  const toProject = useProjectHref();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.append("file", file);
        if (folder) body.append("folder", folder);
        const response = await fetch(toProject("/api/social/upload"), { method: "POST", body });
        const json = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          setError(`${file.name}: ${json.error ?? "the upload failed."}`);
          break;
        }
      }
    } catch {
      setError("The upload failed. Check the connection and try again.");
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
      router.refresh();
    }
  }

  return (
    <div>
      {canEdit ? (
        <div
          className="mb-4 flex flex-col items-center gap-2 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] p-6 text-center text-sm"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void upload(e.dataTransfer.files);
          }}
        >
          <p className="text-[color:var(--color-muted-foreground)]">Drop photos (JPEG, PNG, WebP, GIF up to 8 MB) or videos (MP4, MOV up to 200 MB) here{folder ? ` into “${folder}”` : ""}.</p>
          <Button variant="secondary" onClick={() => input.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ImagePlus className="size-4" aria-hidden />} Choose files
          </Button>
          <input ref={input} type="file" multiple hidden accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime" onChange={(e) => void upload(e.target.files)} />
        </div>
      ) : null}
      {error ? <Alert tone="danger" title={error} /> : null}
      {assets.length === 0 ? (
        <p className="py-10 text-center text-sm text-[color:var(--color-muted-foreground)]">No files here yet.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {assets.map((a) => (
            <li key={a.id} className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
              {a.kind === "VIDEO" ? (
                <video src={toProject(`/api/social/assets/${a.id}`)} className="aspect-square w-full bg-black object-cover" muted preload="metadata" controls />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- served by the project's own checked route
                <img src={toProject(`/api/social/assets/${a.id}`)} alt={a.altText ?? a.name} loading="lazy" className="aspect-square w-full object-cover" />
              )}
              <div className="space-y-1 p-2 text-xs">
                <p className="truncate font-medium" title={a.name}>
                  {a.name}
                </p>
                <p className="text-[color:var(--color-muted-foreground)]">
                  {formatBytes(a.sizeBytes)} · {a.mimeType.split("/")[1]?.toUpperCase()} · in {a.usedInPosts} post(s)
                </p>
                {a.folder || a.tags.length ? <p className="truncate text-[color:var(--color-subtle-foreground)]">{[a.folder, ...a.tags.map((t) => `#${t}`)].filter(Boolean).join(" ")}</p> : null}
                {canEdit ? (
                  editing === a.id ? (
                    <AssetForm asset={a} onDone={() => setEditing(null)} />
                  ) : (
                    <div className="flex gap-2">
                      <button type="button" className="link" onClick={() => setEditing(a.id)}>
                        Edit
                      </button>
                      <DeleteAsset id={a.id} />
                    </div>
                  )
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AssetForm({ asset, onDone }: { asset: SocialAssetView; onDone: () => void }) {
  const [state, action, pending] = useActionState<SocialActionState, FormData>(updateSocialAssetAction, {});
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="id" value={asset.id} />
      <Input name="name" defaultValue={asset.name} aria-label="Name" className="h-8 text-xs" />
      <Input name="folder" defaultValue={asset.folder ?? ""} placeholder="Folder" aria-label="Folder" className="h-8 text-xs" />
      <Input name="tags" defaultValue={asset.tags.join(", ")} placeholder="Tags, comma separated" aria-label="Tags" className="h-8 text-xs" />
      <Input name="altText" defaultValue={asset.altText ?? ""} placeholder="Description (alt text)" aria-label="Alt text" className="h-8 text-xs" />
      {state.error ? <p className="text-[color:var(--color-danger)]">{state.error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={pending}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Close
        </Button>
      </div>
    </form>
  );
}

function DeleteAsset({ id }: { id: string }) {
  const router = useProjectRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-[color:var(--color-danger)] disabled:opacity-50"
        disabled={pending}
        onClick={() => {
          if (!window.confirm("Delete this file from the library?")) return;
          start(async () => {
            const r = await deleteSocialAssetAction(id);
            if (r.error) setError(r.error);
            router.refresh();
          });
        }}
      >
        <Trash2 className="size-3" aria-hidden /> Delete
      </button>
      {error ? <span className="block text-[color:var(--color-danger)]">{error}</span> : null}
    </>
  );
}
