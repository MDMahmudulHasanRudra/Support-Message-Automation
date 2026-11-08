import { BookUser, CalendarPlus, Mail, Phone } from "lucide-react";
import { CONTACT_CONSENT_LABEL, CONTACT_CONSENTS, CONTACT_SOURCE_LABEL, CONTACT_SOURCES } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { listContacts, loadContactFacets, readContactFilters } from "@/server/contacts";
import Link from "@/components/ProjectLink";
import { Button, Card, EmptyState, Field, FilterBar, HelpButton, HelpSection, HeroKpi, Input, PageHeader, Pagination, Select } from "@/components/ui";
import { ContactsTable } from "./ContactsTable";
import { NewContactButton } from "./NewContactButton";

export const metadata = { title: "Contacts" };

const PAGE_SIZES = [25, 50, 100, 200];

/** Contacts (CONTACTS.md): everyone met in the chats, apart from the client and billing lists. */
export default async function ContactsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requireAccess("contacts.view", "CONTACTS");
  const params = await searchParams;
  const filters = readContactFilters(params);
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.size)) ? Number(params.size) : 50;

  const [list, facets, canEdit, canDelete, canExport, canCampaign, canImport] = await Promise.all([
    listContacts(filters, page, pageSize),
    loadContactFacets(),
    hasPermission(session, "contacts.edit"),
    hasPermission(session, "contacts.delete"),
    hasPermission(session, "contacts.export"),
    hasPermission(session, "contacts.campaign"),
    hasPermission(session, "contacts.import"),
  ]);

  const query: Record<string, string> = {};
  for (const key of ["q", "source", "tag", "has", "consent", "linked", "archived", "size"] as const) if (params[key]) query[key] = params[key]!;
  const href = (overrides: Record<string, string | number | null>) => {
    const qs = new URLSearchParams(query);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) qs.delete(k);
      else qs.set(k, String(v));
    }
    const s = qs.toString();
    return `/contacts${s ? `?${s}` : ""}`;
  };
  const filtering = Boolean(filters.q || filters.source || filters.tag || filters.has || filters.consent || filters.linked);
  const n = (v: number) => v.toLocaleString("en-US");

  return (
    <div className="min-w-0">
      <PageHeader
        title="Contacts"
        description="Everyone you have met in your chats, with their numbers, emails and social accounts. Separate from Clients and Billing."
        actions={
          <>
            <HelpButton moduleTitle="Contacts">
              <HelpSection title="How people get here">
                <p>Beside any chat, open the Contact tab and paste what they sent. You can also add someone by hand, import a file, copy your client list, or let AI collect details once you switch that on in Settings → Contacts.</p>
              </HelpSection>
              <HelpSection title="The same number is never saved twice">
                <p>A number, email or account belongs to one contact. If it is already saved you are told whose it is, and you can merge the two.</p>
              </HelpSection>
              <HelpSection title="Apart from Clients">
                <p>The CT number is its own serial. A contact can point at a client record if you choose, and that never changes the client, its dues or its subscriptions.</p>
              </HelpSection>
            </HelpButton>
            {canImport ? (
              <Link href="/contacts/import" className="inline-flex h-9 items-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] font-medium hover:bg-[var(--color-neutral-bg)]">
                Import
              </Link>
            ) : null}
            {canEdit ? <NewContactButton /> : null}
          </>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <HeroKpi label="All contacts" value={n(facets.active)} icon={BookUser} tone="tide" href="/contacts" />
        <HeroKpi label="Added in the last 7 days" value={n(facets.thisWeek)} icon={CalendarPlus} tone="sea" />
        <HeroKpi label="Phone numbers" value={n(facets.phones)} icon={Phone} tone="navy" href="/contacts?has=PHONE" />
        <HeroKpi label="Email addresses" value={n(facets.emails)} icon={Mail} tone="amber" href="/contacts?has=EMAIL" />
      </div>

      <form method="get">
        {filters.archived ? <input type="hidden" name="archived" value="1" /> : null}
        <FilterBar>
          <Field label="Search">
            <Input name="q" defaultValue={filters.q} placeholder="Name, number, email, CT-0012" />
          </Field>
          <div className="hidden md:contents">
            <Field label="Source">
              <Select name="source" defaultValue={filters.source ?? ""}>
                <option value="">Any source</option>
                {CONTACT_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {CONTACT_SOURCE_LABEL[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tag">
              <Select name="tag" defaultValue={filters.tag ?? ""}>
                <option value="">Any tag</option>
                {facets.tags.map((t) => (
                  <option key={t.tag} value={t.tag}>
                    {t.tag} ({t.count})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Has">
              <Select name="has" defaultValue={filters.has ?? ""}>
                <option value="">Anything</option>
                <option value="PHONE">A phone number</option>
                <option value="EMAIL">An email</option>
                <option value="SOCIAL">A social account</option>
                <option value="NOTHING">Nothing yet</option>
              </Select>
            </Field>
            <Field label="Offers">
              <Select name="consent" defaultValue={filters.consent ?? ""}>
                <option value="">Any answer</option>
                {CONTACT_CONSENTS.map((c) => (
                  <option key={c} value={c}>
                    {CONTACT_CONSENT_LABEL[c]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Client">
              <Select name="linked" defaultValue={filters.linked ?? ""}>
                <option value="">Either</option>
                <option value="yes">Linked to a client</option>
                <option value="no">Not linked</option>
              </Select>
            </Field>
          </div>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          {filtering ? (
            <Link href={filters.archived ? "/contacts?archived=1" : "/contacts"} className="self-center text-[13px] text-[color:var(--color-accent)] hover:underline">
              Clear filters
            </Link>
          ) : null}
        </FilterBar>
      </form>

      {list.items.length === 0 ? (
        <Card>
          <EmptyState>{filtering ? "Nobody matches these filters." : filters.archived ? "Nothing is archived." : "No contacts yet. Open any chat and use the Contact tab, or import a file."}</EmptyState>
        </Card>
      ) : (
        <ContactsTable rows={list.items} total={list.total} filters={filters} canEdit={canEdit} canDelete={canDelete} canExport={canExport} canCampaign={canCampaign} knownTags={facets.tags.map((t) => t.tag)} />
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <Pagination page={page} pageSize={pageSize} total={list.total} buildHref={(p) => href({ page: p })} pageSizeOptions={PAGE_SIZES} buildPageSizeHref={(s) => href({ size: s, page: null })} />
        {facets.archived > 0 || filters.archived ? (
          <Link href={filters.archived ? "/contacts" : "/contacts?archived=1"} className="text-[13px] text-[color:var(--color-accent)] hover:underline">
            {filters.archived ? "Back to the list" : `Archived (${n(facets.archived)})`}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
