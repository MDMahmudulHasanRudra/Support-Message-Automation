"use client";

import { useState } from "react";
import { useProjectHref } from "@/components/ProjectLink";

/**
 * A WhatsApp profile picture laid over the coloured initials (WHATSAPP_AVATARS.md). The initials are
 * always rendered underneath, so a missing picture, a slow one or one that fails to load shows the
 * same avatar as before. The parent must be `relative overflow-hidden` with its own shape.
 */
export function AvatarFace({ path, children }: { path?: string | null; children: React.ReactNode }) {
  const toProject = useProjectHref();
  const [failed, setFailed] = useState(false);
  return (
    <>
      {children}
      {path && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- an authenticated thumbnail of at most 100 KB; next/image would proxy it
        <img src={toProject(path)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />
      ) : null}
    </>
  );
}
