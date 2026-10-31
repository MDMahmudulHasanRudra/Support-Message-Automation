import { listSocialAccounts } from "@/server/social/accounts";
import { listSocialAssets } from "@/server/social/media";
import { listCampaigns, listTemplates } from "@/server/social/library";
import type { ComposerAccount, ComposerAsset, ComposerTemplate } from "./PostComposer";

/** What the composer offers: this project's accounts, recent library files, active campaigns, templates. */
export async function loadComposerChoices(): Promise<{
  accounts: ComposerAccount[];
  assets: ComposerAsset[];
  campaigns: Array<{ id: string; name: string }>;
  templates: ComposerTemplate[];
}> {
  const [accounts, assets, campaigns, templates] = await Promise.all([listSocialAccounts(), listSocialAssets({ take: 120 }), listCampaigns(), listTemplates()]);
  return {
    accounts: accounts.map((a) => ({ id: a.id, platform: a.platform, name: a.name, username: a.username, usable: a.status === "ACTIVE" && a.enabled })),
    assets: assets.map((a) => ({ id: a.id, name: a.name, kind: a.kind, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
    campaigns: campaigns.map((c) => ({ id: c.id, name: c.name })),
    templates: templates.map((t) => ({ id: t.id, kind: t.kind, name: t.name, content: t.content })),
  };
}
