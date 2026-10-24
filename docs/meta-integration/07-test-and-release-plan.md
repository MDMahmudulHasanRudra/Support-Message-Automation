# 07 — Tests and release

Every test ran on the **isolated throwaway database** (127.0.0.1:5434, tmpfs, dropped afterwards),
never on the live or shared one. Every test uses a fake Meta. **Nothing here proves that the live
Meta integration works.** That needs §5.

## 1. Baseline before any change (`e9fb6a5`)

| Suite | Result |
|---|---|
| `packages/shared` | 65 files, **1,101 passed** |
| `apps/web` isolated | 87 files, **1,013 passed**, 7 skipped |
| `apps/worker` isolated | 127 files, **1,383 passed, 2 failed**, 6 skipped |

**The two worker failures already existed.** Both are in `projectFoundation.integration.test.ts`
(the project-scoped table counts, expected 122 / 125, got 124 / 127). The Smart Import release added
`ClientImportRow` and `ClientImportPreset` without updating those counts. They are corrected in this
change, to 125 / 128 including `MetaOAuthSession`, with the reason written next to the numbers.

## 2. New tests

| Suite | What it pins | Count |
|---|---|---|
| shared `metaPlatform.test.ts` | config is off unless enabled; problems are named by variable, never by value; redirect URI rules; scope reading; Page-role rule; asset classification (here / manual here / elsewhere / missing permission / missing role / no Instagram), and another workspace is never named; `signed_request` (good, wrong secret, tampered, wrong algorithm, garbage) | 13 |
| web `metaOAuth.integration.test.ts` | the whole flow against a fake Meta in three projects, see below | 25 |
| worker `metaPlatform.integration.test.ts` | send signed with the platform secret, or not sent; health check: unconfigured, not due, manual untouched, resubscribe, resubscribe refused, network failure, dead token; then the queue sends nothing; abandoned attempts expire | 9 |

The web suite covers:

- off means off;
- permission;
- the dialog URL, with `config_id` or `scope`;
- unknown, declined, replayed and expired state;
- a code Meta refuses;
- the encrypted long-lived token;
- the claim refused to another person, without the binding cookie, with a wrong cookie, in another
  project, or a second time;
- the choice screen refused to another person or project;
- classification;
- a declined permission;
- a viewer refused;
- Messenger + Instagram + a manual Page switched on the same row + refused rows;
- secrets absent from views and logs;
- the old manual URL refused;
- a subscription failure → ERROR;
- a token for a different Page refused;
- the database refusing a second one-click project while still allowing manual;
- webhook handshake, signature, routing to the right project, dedup, unknown and manual accounts
  dropped, a manual URL never feeding a one-click row;
- health with the platform secret, and a dead token → reconnect;
- the shared-subscription disconnect;
- deauthorize, signed and unsigned;
- data deletion, with its status.

### Mutation check (each test proven to fail against broken code)

Each line is one defect, put in alone; the suite must fail.

| Defect | Result |
|---|---|
| web: claim binding not checked · claim user not checked · state reusable · state never expires · choice opens for another user · CONNECTED without subscription · user token not wiped · platform webhook matches manual rows · platform webhook signature not checked · unsubscribe despite a sibling · deauthorize ignores the signature · deletion keeps the Facebook id · integration "off" still starts · manual sibling routing includes PLATFORM rows · a token for another Page accepted | **15 / 15 caught.** The last two were missed at first; a test was added for each, and both are now caught. |
| worker: platform secret not used · dead token not marked · no resubscribe · network failure becomes ERROR · manual connections checked too · abandoned attempts kept · recently checked re-checked | **7 / 7 caught** |
| shared: another workspace not refused · `signed_request` signature not checked · always enabled · Page role check weakened | **4 / 4 caught** |

## 3. Regression after the change

See §6, filled in from the actual runs.

## 4. Browser check (isolated dev server)

The browser check runs against a fake Meta:

- a test-only preload script answers `graph.facebook.com` calls;
- the headless browser's request to `www.facebook.com/…/dialog/oauth` is answered with the redirect
  Meta sends after approval.

Everything else is the real app: the start route, the callback, the claim, the choice screen and
the connect action. See §6 for what was seen.

## 5. Live Meta verification (required before production)

`META_DEVELOPER_SETUP.md` §8 is the checklist: Development mode with an app-role tester first, then
Live after App Review. Record the date, the Graph API version and the granted permissions. **Until it
has been done, the status of this feature is "mock-tested", not "live-tested".**

## 6. Results (24 Oct 2026, branch `feat/meta-oauth`)

| Check | Result |
|---|---|
| `packages/shared` | 66 files, **1,114 passed** (1,101 + 13 new) |
| `apps/web` isolated, full | 88 files, **1,038 passed**, 7 skipped (1,013 + 25 new), no failure |
| `apps/worker` isolated, full | 127 files, **1,394 passed**, 6 skipped, no failure (1,383 + the 2 corrected counts + 9 new) |
| `tsc --noEmit` web and worker | clean |
| `pnpm lint` | 0 errors, 8 warnings (the same 8 as before) |
| `pnpm build` web and worker | succeeded |

**Browser** (isolated dev server, fake Meta, 1440 px and 390 px):

- Settings → Messaging Channels shows the "Connect with Facebook" card. The manual buttons read
  "Connect with your own Meta app".
- "Connect Facebook Page" opened Meta's dialog for the platform app id with exactly the five
  permissions.
- Back on the choice screen:
  - the first Page as Messenger and Instagram, "Ready to connect";
  - the second as Messenger, "Ready to connect", and Instagram, "No Instagram account linked";
  - the third, "Your Page role is not enough".
- Ticking the first Page's two rows and pressing Connect gave "2 of 2 connected".
- The connection page shows "Connected with Facebook" with the granted permissions and "Reconnect
  with Facebook", and no Callback URL or Verify token.
- No page scrolls sideways at 390 px.

**One defect was found by the browser check and fixed.** The connect action called `revalidatePath`.
That re-rendered the choice screen right after saving, and the attempt, now finished, could no longer
be opened. The person saw "expired or already used" instead of the results, although both accounts
had connected.

- The action no longer revalidates.
- A finished attempt that is opened again now shows what it connected.
- The browser check was repeated after the fix and passed. The web tests were re-run (64 passed).
