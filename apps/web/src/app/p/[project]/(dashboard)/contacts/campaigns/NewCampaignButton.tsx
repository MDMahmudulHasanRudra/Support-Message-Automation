"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui";
import { NewCampaignDialog } from "./NewCampaignDialog";

export function NewCampaignButton({ knownTags }: { knownTags: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        New campaign
      </Button>
      {open ? <NewCampaignDialog open onClose={() => setOpen(false)} selection={null} count={null} knownTags={knownTags} /> : null}
    </>
  );
}
