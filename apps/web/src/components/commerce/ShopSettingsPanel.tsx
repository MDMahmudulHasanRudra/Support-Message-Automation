"use client";

import { useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { SHOP_LABELS, type ShopProvider } from "@support-automation/shared";
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, Field, Input, SectionHeader, Select, Table, Td, Th, useToast } from "@/components/ui";
import { importFromShop, removeShopConnection, revealShopWebhookSecret, saveShopConnection, testShopConnection } from "@/server/actions/shops";

export interface ShopConnectionView {
  id: string;
  label: string;
  shopUrl: string;
  currency: string | null;
  isActive: boolean;
  importOrders: boolean;
  hasWebhookSecret: boolean;
  webhookUrl: string | null;
  lastSyncAt: string | null;
  lastSyncOk: boolean | null;
  lastError: string | null;
  lastWebhookAt: string | null;
  imported: number;
  importedOrders: number;
  runs: Array<{ id: string; kind: string; status: string; created: number; updated: number; unchanged: number; skipped: number; failed: number; errors: string[]; actorUsername: string | null; startedAt: string; finishedAt: string | null }>;
}

const when = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "never";

const RUN_COLOR: Record<string, "green" | "yellow" | "red" | "gray" | "blue"> = { SUCCEEDED: "green", PARTIAL: "yellow", FAILED: "red", RUNNING: "blue", UNKNOWN: "yellow" };

const TOPICS: Record<ShopProvider, string[]> = {
  WOOCOMMERCE: ["Product created", "Product updated", "Product deleted", "Order created", "Order updated"],
  SHOPIFY: ["products/create", "products/update", "products/delete", "orders/create", "orders/updated"],
};

/** Settings → WooCommerce / Shopify: connect, test, import, webhooks, run history. */
export function ShopSettingsPanel({ provider, view, canManage }: { provider: ShopProvider; view: ShopConnectionView | null; canManage: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [days, setDays] = useState("30");
  const [form, setForm] = useState({
    label: view?.label ?? SHOP_LABELS[provider],
    shopUrl: view?.shopUrl ?? "",
    consumerKey: "",
    consumerSecret: "",
    accessToken: "",
    webhookSecret: "",
    importOrders: view?.importOrders ?? false,
    isActive: view?.isActive ?? true,
  });
  const label = SHOP_LABELS[provider];

  const run = (fn: () => Promise<{ error?: string; success?: string }>, after?: () => void) => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const r = await fn();
      if (r.error) setError(r.error);
      else {
        setNotice(r.success ?? null);
        showToast({ tone: "success", title: r.success ?? "Done" });
        after?.();
      }
      router.refresh();
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <SectionHeader
          title="Connection"
          description={
            provider === "WOOCOMMERCE"
              ? "WooCommerce → Settings → Advanced → REST API: add a key with Read/Write permission."
              : "Shopify admin → Settings → Apps → Develop apps: create an app with the read_products, read_inventory, read_orders and write_draft_orders scopes, install it, and copy the Admin API access token."
          }
          action={
            view ? (
              <Badge color={!view.isActive ? "gray" : view.lastSyncOk === true ? "green" : view.lastSyncOk === false ? "red" : "yellow"} dot>
                {!view.isActive ? "Off" : view.lastSyncOk === true ? "Working" : view.lastSyncOk === false ? "Failing" : "Not tested"}
              </Badge>
            ) : (
              <Badge color="gray">Not connected</Badge>
            )
          }
        />
        {view?.lastError ? <p className="mb-3 text-xs text-[color:var(--color-danger)]">{view.lastError}</p> : null}
        {canManage ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => saveShopConnection({ provider, ...form }), () => setForm((f) => ({ ...f, consumerKey: "", consumerSecret: "", accessToken: "", webhookSecret: "" })));
            }}
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Shop address" required hint={provider === "SHOPIFY" ? "your-store.myshopify.com" : "https://your-shop.com"}>
                <Input value={form.shopUrl} onChange={(e) => setForm({ ...form, shopUrl: e.target.value })} required />
              </Field>
              <Field label="Name">
                <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} maxLength={80} />
              </Field>
              {provider === "WOOCOMMERCE" ? (
                <>
                  <Field label="Consumer key" hint={view ? "Leave empty to keep the saved key." : undefined}>
                    <Input value={form.consumerKey} onChange={(e) => setForm({ ...form, consumerKey: e.target.value })} autoComplete="off" placeholder="ck_…" />
                  </Field>
                  <Field label="Consumer secret" hint={view ? "Leave empty to keep the saved secret." : undefined}>
                    <Input type="password" value={form.consumerSecret} onChange={(e) => setForm({ ...form, consumerSecret: e.target.value })} autoComplete="off" placeholder="cs_…" />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Admin API access token" hint={view ? "Leave empty to keep the saved token." : undefined}>
                    <Input type="password" value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} autoComplete="off" placeholder="shpat_…" />
                  </Field>
                  <Field label="API secret key" hint="Signs the store's webhooks. Leave empty to keep the saved one.">
                    <Input type="password" value={form.webhookSecret} onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })} autoComplete="off" />
                  </Field>
                </>
              )}
            </div>
            <div className="flex flex-wrap gap-6 text-sm">
              <label className="flex items-center gap-2">
                <Checkbox checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Use this shop
              </label>
              <label className="flex items-center gap-2">
                <Checkbox checked={form.importOrders} onChange={(e) => setForm({ ...form, importOrders: e.target.checked })} /> Import the shop&apos;s orders too
              </label>
            </div>
            {error ? <Alert tone="danger">{error}</Alert> : null}
            {notice ? <Alert tone="success">{notice}</Alert> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={pending}>
                {view ? "Save" : "Connect"}
              </Button>
              {view ? (
                <>
                  <Button type="button" variant="secondary" loading={pending} onClick={() => run(() => testShopConnection(provider))}>
                    Test connection
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setRemoving(true)}>
                    Disconnect
                  </Button>
                </>
              ) : null}
            </div>
          </form>
        ) : view ? (
          <p className="text-sm">
            {view.shopUrl} {view.currency ? `· ${view.currency}` : ""}
          </p>
        ) : null}
      </Card>

      {view ? (
        <Card>
          <SectionHeader title="Import" description={`${view.imported} products and ${view.importedOrders} orders imported so far. Importing again updates them; nothing is duplicated.`} />
          {canManage ? (
            <div className="flex flex-wrap items-end gap-2">
              <Button loading={pending} onClick={() => run(() => importFromShop(provider, "PRODUCTS"))}>
                Import products and stock
              </Button>
              {view.importOrders ? (
                <>
                  <Field label="Orders from the last">
                    <Select value={days} onChange={(e) => setDays(e.target.value)} className="w-32">
                      {["1", "7", "30", "90"].map((d) => (
                        <option key={d} value={d}>
                          {d} day{d === "1" ? "" : "s"}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button variant="secondary" loading={pending} onClick={() => run(() => importFromShop(provider, "ORDERS", Number(days)))}>
                    Import orders
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      {view ? (
        <Card>
          <SectionHeader
            title="Webhooks"
            description={`Keep products${view.importOrders ? " and orders" : ""} up to date without importing by hand. Last received: ${when(view.lastWebhookAt)}.`}
          />
          {view.webhookUrl ? (
            <div className="space-y-3 text-sm">
              <Field label="Delivery URL">
                <Input readOnly value={view.webhookUrl} onFocus={(e) => e.currentTarget.select()} className="font-[family-name:var(--font-mono)] text-xs" />
              </Field>
              <p>
                In {label}, add a webhook for each of: <span className="font-medium">{TOPICS[provider].join(", ")}</span>, with the delivery URL above
                {provider === "WOOCOMMERCE" ? " and the secret below (API version WP REST API Integration v3)." : ", format JSON. Shopify signs them with the app's API secret key saved above."}
              </p>
              {provider === "WOOCOMMERCE" && canManage ? (
                secret ? (
                  <Field label="Secret">
                    <Input readOnly value={secret} onFocus={(e) => e.currentTarget.select()} className="font-[family-name:var(--font-mono)] text-xs" />
                  </Field>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      startTransition(async () => {
                        const r = await revealShopWebhookSecret(provider);
                        if (r.secret) setSecret(r.secret);
                        else setError(r.error ?? "Not available.");
                      })
                    }
                  >
                    Show secret
                  </Button>
                )
              ) : null}
              {!view.hasWebhookSecret ? <Alert tone="warning">No webhook secret is saved, so every webhook is refused until one is.</Alert> : null}
            </div>
          ) : (
            <Alert tone="warning">The server&apos;s public address (NEXTAUTH_URL) is not set, so the webhook address cannot be shown.</Alert>
          )}
        </Card>
      ) : null}

      {view && view.runs.length ? (
        <Card>
          <SectionHeader title="Recent runs" />
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>What</Th>
                <Th>Result</Th>
                <Th>Counts</Th>
                <Th>Notes</Th>
              </tr>
            </thead>
            <tbody>
              {view.runs.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap text-xs">
                    {when(r.startedAt)}
                    <span className="block text-[color:var(--color-muted-foreground)]">{r.actorUsername ?? ""}</span>
                  </Td>
                  <Td className="text-xs">{r.kind === "PRODUCTS" ? "Products" : r.kind === "ORDERS" ? "Orders" : "Send order"}</Td>
                  <Td>
                    <Badge color={RUN_COLOR[r.status] ?? "gray"}>{r.status.toLowerCase()}</Badge>
                  </Td>
                  <Td className="tabular text-xs">
                    +{r.created} · ~{r.updated} · ={r.unchanged}
                    {r.failed ? ` · ✕${r.failed}` : ""}
                    {r.skipped ? ` · skipped ${r.skipped}` : ""}
                  </Td>
                  <Td className="max-w-[28rem] text-xs text-[color:var(--color-muted-foreground)]">{r.errors.slice(0, 3).join(" · ") || "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}

      {view ? (
        <ConfirmDialog
          open={removing}
          onClose={() => setRemoving(false)}
          tone="danger"
          loading={pending}
          title={`Disconnect ${label}?`}
          description="The saved credentials, webhook secret and run history are deleted. Imported products and orders are kept. Remove the webhooks in the shop too."
          confirmLabel="Disconnect"
          onConfirm={() => run(() => removeShopConnection(provider), () => setRemoving(false))}
        />
      ) : null}
    </div>
  );
}
