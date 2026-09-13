# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Softifybd's own internal support/operations team: support executives who answer customer
WhatsApp conversations, escalation managers who track SLA breaches, and admins who configure
automation, AI, and team schedules. Desk-based, checked constantly through the workday — this is
the tool they operate from, not something opened occasionally. Not multi-tenant: one company's
own team, on their own data, with no external/customer-facing viewers of the dashboard itself.

## Product Purpose

Softify Assist is rule-based + AI-hybrid WhatsApp support automation for Softifybd's ISP software
product (ISPDIGITAL). It decides what happens to every incoming customer WhatsApp message
(auto-reply, escalate, hand to AI, flag for a human), tracks who on the team handled what and for
how long, manages shift/leave/attendance for the support roster, learns from real conversations to
propose new automation, and mirrors resolved issues into Microsoft Teams. Success is a support
team that can see, at a glance, what needs their attention right now and trust that nothing
customer-facing is silently falling through.

## Positioning

Not a generic CRM/helpdesk skin. The real differentiation is (1) WhatsApp-native automation
depth — group membership, session/media handling, multi-account routing, reconnect/catch-up
reliability engineering most helpdesk tools never build, and (2) an AI layer that knows the limits
of its own authority: it is classified and gated so it never answers a business-specific question
(pricing, policy, account details) without verified knowledge behind it, handing off to a human
instead of guessing. The redesign should read as operational trust and control — a team can see
system health, automation state, and who is covering what — not just enterprise polish for its own
sake.

## Operating Context

Bangladesh business context: Bangla/Banglish/English mixed conversations, Asia/Dhaka fixed
UTC+6 (no DST) governs every "today"/day-boundary calculation across the product. The core daily
loop is triage (what needs attention: unanswered messages, open escalations, unknown patterns) →
action (a rule fires, AI answers, or a person replies manually) → oversight (is automation
healthy, is the WhatsApp connection up, who is on shift, how is the team performing). Desktop is
the primary surface; the team is not doing this work from a phone.

## Capabilities and Constraints

Next.js 16 App Router (Server Components + Server Actions), Tailwind v4 with CSS custom-property
design tokens, no component library (a small hand-built kit in `src/components/ui/`), no charting
library (charts are hand-rolled inline SVG). ~75+ routes across Messages, Escalations, Support
Activity, Team Management, Teams Integration, WhatsApp Accounts/Groups, Automation Rules, Bulk
Messaging, AI Learning, Conversation Learning, Release Notes, System, and Users & Permissions —
every route, server action, permission, and piece of business logic already in production and
must continue working exactly as it does today. This redesign is the visual/UX layer only: no
schema change, no API contract change, no automation/AI/WhatsApp/Teams behavior change.

## Brand Commitments

None binding. Internal tool only — no external stakeholder sees this dashboard, so the provided
palette (Primary #0F172A, Secondary #4F46E5, Tertiary #0EA5E9, Neutral #64748B; Inter for
headline/body, JetBrains Mono for labels/data) is free to become the product's visual identity
outright. Existing confirmed name: **Softify Assist**.

## Evidence on Hand

- `apps/web/src/app/globals.css` — the current design-token system (colors, radii, shadows,
  motion) to be replaced/extended, not the palette itself, which the user has already chosen.
- `apps/web/src/components/ui/` — ~24 existing primitives (Card, Badge, Table, Button, Dialog,
  StatTile, PageHeader, etc.) that the redesign should evolve in place, not replace wholesale.
- `apps/web/src/components/ui/BrandMark.tsx` — the current logo mark.
- `ENGINEERING_STANDARDS.md`, `PROJECT_REFERENCE.md`, `CLAUDE.md` — durable rules and a
  page-by-page functional reference for the whole product; read before touching a page not
  already familiar.
- Two reference screenshots (light + dark) of a "Precision Enterprise Console" theming tool
  showing the exact palette/token values above, plus button/card/input treatments to draw from.

## Product Principles

1. **Answer the ten operational questions fast.** What's happening now, what needs attention, who
   is handling it, is automation/AI/WhatsApp healthy — every screen should make at least one of
   these legible without a click.
2. **Trust over decoration.** This is safety-and-reliability software wearing an ERP face; a
   confident, calm surface matters more than visual flourish. Status must always read as fact, not
   vibe.
3. **One system, everywhere.** A component built once must look and behave identically on every
   one of the ~75 routes — inconsistency here reads as untrustworthy in exactly the software whose
   job is to be trusted.
4. **The redesign changes only what render.** Every route, permission check, server action, and
   business rule already shipped stays byte-for-byte behaviorally identical; only how it looks and
   is organized changes.

## Accessibility & Inclusion

Existing constraint to preserve: touch/hit-target sizing is scoped to `pointer: coarse` media
queries rather than screen width (a narrow desktop window is still a mouse; a large tablet is
still a finger) — carry this rule forward rather than reintroducing width-based touch targets.
