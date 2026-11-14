"use client";

import { useMemo, useState } from "react";
import {
  Bot,
  Boxes,
  BookOpen,
  Camera,
  CreditCard,
  FileSpreadsheet,
  Globe,
  Mail,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  Search,
  Send,
  ShoppingBag,
  Store,
  Truck,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import type { IntegrationCard, IntegrationCategory, IntegrationIcon, IntegrationState } from "@/server/integrationsDirectory";
import { Badge, type BadgeColor } from "@/components/ui";
import ProjectLink from "@/components/ProjectLink";

/** Generic glyphs, never brand logos (they are trademarks); the name is always written beside them. */
const ICONS: Record<IntegrationIcon, { icon: LucideIcon; tint: string }> = {
  whatsapp: { icon: MessageCircle, tint: "var(--chart-3)" },
  messenger: { icon: MessagesSquare, tint: "var(--chart-6)" },
  instagram: { icon: Camera, tint: "var(--chart-5)" },
  telegram: { icon: Send, tint: "var(--chart-2)" },
  webchat: { icon: Globe, tint: "var(--chart-4)" },
  email: { icon: Mail, tint: "var(--chart-1)" },
  commerce: { icon: Boxes, tint: "var(--chart-2)" },
  woocommerce: { icon: Store, tint: "var(--chart-6)" },
  shopify: { icon: ShoppingBag, tint: "var(--chart-3)" },
  courier: { icon: Truck, tint: "var(--chart-4)" },
  payments: { icon: CreditCard, tint: "var(--chart-5)" },
  sheets: { icon: FileSpreadsheet, tint: "var(--chart-3)" },
  ai: { icon: Bot, tint: "var(--chart-1)" },
  knowledge: { icon: BookOpen, tint: "var(--chart-2)" },
  social: { icon: Megaphone, tint: "var(--chart-5)" },
  api: { icon: Webhook, tint: "var(--chart-6)" },
};

const STATE: Record<IntegrationState, { label: string; color: BadgeColor }> = {
  CONNECTED: { label: "Connected", color: "green" },
  ATTENTION: { label: "Needs attention", color: "yellow" },
  NOT_SET_UP: { label: "Not connected", color: "gray" },
  MODULE_OFF: { label: "Off", color: "gray" },
};

type Filter = "All" | "Connected" | IntegrationCategory;

export function IntegrationsDirectory({ cards, categories }: { cards: IntegrationCard[]; categories: IntegrationCategory[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  const connected = cards.filter((c) => c.state === "CONNECTED").length;
  const attention = cards.filter((c) => c.state === "ATTENTION").length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cards.filter((c) => {
      if (filter === "Connected" && c.state !== "CONNECTED") return false;
      if (filter !== "All" && filter !== "Connected" && c.category !== filter) return false;
      return !q || `${c.name} ${c.description} ${c.keywords}`.toLowerCase().includes(q);
    });
  }, [cards, filter, query]);

  const chips: Filter[] = ["All", "Connected", ...categories.filter((cat) => cards.some((c) => c.category === cat))];
  // Within a group: what needs fixing first, then what works, then what could be added; off last.
  const order: Record<IntegrationState, number> = { ATTENTION: 0, CONNECTED: 1, NOT_SET_UP: 2, MODULE_OFF: 3 };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3">
        <label className="relative block max-w-md">
          <span className="sr-only">Search integrations</span>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[color:var(--color-subtle-foreground)]" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search, e.g. Shopify or bKash"
            className="h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] pl-9 pr-3 text-[13px] text-[color:var(--color-foreground)] placeholder:text-[color:var(--color-subtle-foreground)] focus:border-[var(--color-accent)] focus:outline-none"
          />
        </label>
        <div className="-mx-1 flex flex-wrap gap-1.5 px-1" role="tablist" aria-label="Show">
          {chips.map((chip) => (
            <button
              key={chip}
              type="button"
              role="tab"
              aria-selected={filter === chip}
              onClick={() => setFilter(chip)}
              className={`h-8 shrink-0 whitespace-nowrap rounded-full border px-3 text-[12.5px] font-medium transition-colors ${
                filter === chip
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-bg)] text-[color:var(--color-foreground)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
              }`}
            >
              {chip}
              {chip === "Connected" ? ` (${connected})` : null}
            </button>
          ))}
        </div>
      </div>

      {attention > 0 ? (
        <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
          {attention === 1 ? "1 integration needs" : `${attention} integrations need`} attention: its card says what to do.
        </p>
      ) : null}

      {visible.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-[color:var(--color-muted-foreground)]">No integration matches “{query}”.</p>
      ) : (
        (filter === "All" || filter === "Connected" ? categories : [filter as IntegrationCategory]).map((cat) => {
          const group = visible.filter((c) => c.category === cat).sort((a, b) => order[a.state] - order[b.state]);
          if (group.length === 0) return null;
          return (
            <section key={cat} aria-label={cat}>
              <h2 className="mb-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[color:var(--color-subtle-foreground)]">{cat}</h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {group.map((card) => (
                  <IntegrationTile key={card.id} card={card} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

function IntegrationTile({ card }: { card: IntegrationCard }) {
  const { icon: Icon, tint } = ICONS[card.icon];
  const state = STATE[card.state];
  const primary = card.state === "NOT_SET_UP" || card.state === "ATTENTION";
  return (
    <div className="flex flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)]">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          style={{ background: `color-mix(in srgb, ${tint} 15%, transparent)`, color: tint }}
          className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-md)]"
        >
          <Icon className="size-5" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[14px] font-semibold text-[color:var(--color-foreground)]">{card.name}</h3>
            <Badge color={state.color} dot={card.state === "CONNECTED"}>
              {state.label}
            </Badge>
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">{card.description}</p>
        </div>
      </div>
      {card.detail ? (
        <p className={`mt-3 text-[12px] ${card.state === "ATTENTION" ? "text-[color:var(--color-warning-fg)]" : "text-[color:var(--color-muted-foreground)]"}`}>{card.detail}</p>
      ) : null}
      {card.action || card.secondary ? (
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
          {card.action ? <TileLink href={card.action.href} external={card.action.external} primary={primary} label={card.action.label} name={card.name} /> : null}
          {card.secondary ? (
            <TileLink
              href={card.secondary.href}
              external={card.secondary.href.startsWith("/admin/")}
              primary={false}
              quiet
              label={card.secondary.label}
              name={card.name}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TileLink({ href, external, primary, quiet, label, name }: { href: string; external?: boolean; primary: boolean; quiet?: boolean; label: string; name: string }) {
  const cls = quiet
    ? "inline-flex h-8 items-center px-1 text-[12.5px] font-medium text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
    : primary
      ? "inline-flex h-8 items-center rounded-[var(--radius-md)] bg-[var(--color-primary)] px-3.5 text-[12.5px] font-semibold text-[var(--color-on-primary)] shadow-[var(--shadow-sm)] hover:bg-[var(--color-primary-hover)]"
      : "inline-flex h-8 items-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 text-[12.5px] font-medium text-[color:var(--color-foreground)] hover:bg-[var(--color-surface-sunken)]";
  const aria = `${label}: ${name}`;
  // The Main Admin portal is outside the project, so it must not be rewritten into a project path.
  return external ? (
    <a href={href} className={cls} aria-label={aria}>
      {label}
    </a>
  ) : (
    <ProjectLink href={href} className={cls} aria-label={aria}>
      {label}
    </ProjectLink>
  );
}
