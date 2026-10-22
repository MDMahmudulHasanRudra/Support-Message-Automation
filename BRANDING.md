# White labeling (Branding)

Main Admin → **Branding** (`/admin/branding`) sets what this installation calls itself and how it
looks. It is platform-wide: every project, every page, the sign-in page and the browser tab show
the same brand. Projects are renamed separately, on Main Admin → Projects → a project → **Details**.

## What can be changed

| Setting | Where it shows | Empty means |
|---|---|---|
| Product name | Browser tab titles, the sidebar ("Main Admin / <name>", "<name> project"), the breadcrumb, the sign-in page, the Main Admin descriptions, and the AI Admin Assistant's introduction | "Softify Assist" |
| Sign-in headline and text | The sign-in page's dark panel | The built-in wording |
| Brand colour | Links, the active menu item, highlights, focus rings (the design system's *accent*), in light and dark themes | The built-in indigo |
| Logo (wide) | The sign-in page, on a white plate | The app icon and the product name |
| App icon (square) | The sidebar mark and the browser tab icon (favicon) | The built-in mark |

## Defaults (21 Oct 2026)

- The built-in product name is **Nexora** (`DEFAULT_BRANDING.productName`). A new install's first
  project is **Nexora Project 1** (`nexora-project-1`), and Create project offers the next free
  **Nexora Project N** (`nextDefaultProjectName`). Use these names wherever a default is needed.
- **Existing installs are not changed.** Migration `20261021090000_nexora_white_label_defaults`
  stores "Softify Assist" in `PlatformBranding.productName` for any install that already had a user
  and no saved name, and renames the original project only on an empty database. An install with
  its own saved name keeps it. Verified on three throwaway databases.
- Internal identifiers (cookie and header names `softify-*`, the npm scope, the project id
  `proj_isp_digital`) are never shown and are deliberately left as they are: renaming a cookie signs
  everybody out, and the id is referenced by migrations.
- Softify Forge is an external integration's own name; the UI calls it "Forge".

## Rules worth not undoing

- **One row, NULL = default** (`PlatformBranding`, id `default`, no `projectId`). A fresh install has no
  row and looks exactly as before. Saving the default text, or clearing a field, stores NULL, so the
  field keeps following the built-in wording — the same shape as Notification Templates.
- **Only a Main Admin changes it** (`projects.manage`), checked inside every action
  (`server/actions/branding.ts`), because a Server Action is a public endpoint. Anyone in the portal
  (`projects.view`) can look. No new permission key.
- **The brand colour moves only the accent.** The near-black "ink" primary (buttons, sidebar
  selection) stays, so no colour can make the controls unreadable. A colour with contrast below 3
  on white is allowed but warned about in the form. The value is a validated `#rrggbb` before it
  reaches the inline style sheet (`accentStyleSheet`), whose selectors outrank `globals.css`
  (`:root:root`) in all three theme states.
- **Images are stored in the database** (≤ 512 KB each): they are needed on the sign-in page, and
  they must survive a database backup with the rest of the configuration.
  - The type is **sniffed from the bytes**, never the file name or the browser's claim. PNG, JPEG,
    WebP, GIF, ICO and SVG are accepted.
  - An SVG with script, event handlers, `javascript:` or `foreignObject` is refused outright.
  - Served by `GET /api/brand/logo|icon` (public — the sign-in page needs them) with `nosniff` and a
    sandboxing CSP, so even an SVG opened directly in a tab cannot run anything.
  - `assetVersion` moves on every image change and is part of the URL (`?v=`). A matching version is
    cached for good; anything else is revalidated, so a new upload shows at once.
  - With no icon uploaded, the route serves the built-in icon from the same address, so the favicon
    has exactly one source (`app/icon.svg` was removed for that reason).
- **Reading fails open.** `getBranding()` (`server/branding.ts`) runs in the root layout; a missing
  row or an unreadable database gives the built-in brand rather than a broken sign-in page. It never
  selects the image bytes.
- **The root layout is per request** (`connection()`), so a build never freezes the brand it saw at
  build time.
- **A project's address (slug) is never editable**: it is in every bookmark and shared link. Only its
  name and description change (`updateProjectDetails`), and a name must stay unique ignoring case.

## Tests

`apps/web/src/__tests__/branding.test.ts` (pure rules) and `branding.integration.test.ts` (actions,
permissions, the image route, renaming). Each rule was confirmed to fail its test when removed.
