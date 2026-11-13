# Chithii design system: Premium Tide Board

One theme for the project software (`/p/<slug>`) and the Main Admin Portal (`/admin`). Tokens live in `src/app/globals.css`.

## World

- **The field:** one deep sea-teal L holds the header and the navigation. `.tide-field` re-scopes the ordinary colour tokens for everything inside it, so nav, switcher, search and badges need no special case. It stays deep in light and dark mode.
- **The sheet:** the page sits on a light sheet with a rounded top-left corner (dark mode: near-black teal).
- **White label:** a brand colour moves `--tide-bg`, `--tide-active`, `--tide-mark` and the accent tokens (`accentStyleSheet`, `lib/branding.ts`). Never hard-code the teal in a component; the hero gradients in `HeroKpi` are the one deliberate exception.
- **Marigold** (`--marigold`, secondary tokens) marks what needs a person. Status colours keep their meaning everywhere and are never decoration.

## Shared parts

| Part | Where | Use |
|---|---|---|
| `ShellSearch`, `ShellUserMenu`, `navItemClass` | `components/shell/ShellParts.tsx` | Both portals' header and sidebar |
| `HeroKpi` | `components/ui` | The four large figures at the top of an overview; `tide`, `sea`, `navy`, `amber` |
| `StatTile` with `icon` | `components/ui` | Secondary figures; tint follows the tone |
| `ActionList`, `HealthList`, `QuickActions`, `ActivityFeed`, `ModuleSummary`, `GettingStarted`, `ChartEmpty` | `components/dashboard` | The cards an overview is made of |
| `ChartCard` with `icon` | `components/charts` | Every chart; the charts stay hand-rolled SVG |

## Rules

- Real data only. A figure with no history has no line, one with no comparison has no change, and an empty chart says what would fill it.
- Offer only what the viewer can open: `link()` / `canUse()` on the Overview, permission keys in `/admin`.
- A section for a module appears only while that module is on.
- `/admin` is a customer's own portal. Billing, plans and revenue belong to `/platform`, never here.
- Inter throughout, tabular figures, sentence-case headings. Cards use `--radius-xl`, inner controls `--radius-md`.
