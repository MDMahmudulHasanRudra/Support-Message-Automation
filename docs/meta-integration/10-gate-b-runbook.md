# 10 — Gate B runbook: the controlled live test on production

Approved 27 Oct 2026, under conditions. The test runs on production, limited to the **internal test
workspace** and to the **internal Meta test accounts** (people with a role on the platform's Meta app,
which stays in Development mode). Any of these stops the test at once:

- tenant isolation is broken;
- authentication is broken;
- WhatsApp processing is affected;
- an existing customer's functionality is affected.

Undo it with §6.

## 1. Fixed values

| What | Value |
|---|---|
| Platform address (HOST) | `https://admin.getassist.pro` (09 §1) |
| Callback / webhook / deauthorize / data deletion | `https://admin.getassist.pro/api/meta/oauth/callback`, `/api/meta/webhook`, `/api/meta/deauthorize`, `/api/meta/data-deletion` |
| Internal test workspace | **GetAssistAdmindemo**, project id `cmvpjywxv000ol2cjkzkd75r9`, customer "MD Mahmudul Hasan Rudra", address `https://demo.getassist.pro` |
| Allowlist | `META_ALLOWED_PROJECT_IDS=cmvpjywxv000ol2cjkzkd75r9` — that workspace only |

## 2. Pre-checks (27 Oct 2026)

| # | Safeguard | Result |
|---|---|---|
| 1 | The four endpoints on admin.getassist.pro | **Pass.** All four reach the app with a valid certificate. Switched off, they answer 404; deauthorize GET is 405. The callback with an unknown attempt redirects with `meta_error=expired` and stores nothing. The webhook handshake is re-checked after activation (§4). |
| 2 | OAuth returns only to the workspace that started it | **Pass (tests).** web `metaOAuth.integration` §2: the callback redirects to the stored `returnOrigin` + `/p/<slug>`; the claim needs the same person, the same browser (HTTP-only binding cookie) and the same project. Another person, a missing or wrong cookie, or another project are refused, and the claim is single-use. |
| 3 | Tenant isolation across customer addresses | **Pass (tests).** `saasTwoLayers.integration` (19), and `metaOAuth.integration`: webhook events route by account id to their own project; another workspace's attempt is "not found"; one Page can be live in only one workspace (database index). |
| 4 | Authentication and permissions | **Pass (tests).** Start needs a session, a customer or open address (never the platform address), and `channels.manage`; a viewer is refused at start and at connect. The callback needs no session, but it can only redeem the code and send the browser back. |
| 5 | Off for every existing customer workspace | **Fixed by code, before activation.** Found: the Omnichannel module is ON in every workspace (all plans include all modules), so the flag alone would have shown "Connect with Facebook" everywhere. Added `META_ALLOWED_PROJECT_IDS`, which **fails closed** (empty = no workspace) and is checked at start, callback, claim, choice, connect, both settings pages and the platform webhook. Each check is confirmed to fail its test when removed. No production setting changed. AI: no channel connection exists anywhere (0 rows), and AI is per connection and off by default. |
| 6 | Internal accounts and workspace only | Meta app in **Development** mode: only people with an app role can authorise. Allowlist = the internal workspace only. |
| 7 | Backup and rollback | The backup is taken by the activation script, immediately before the switch (§4). Rollback: §6. |
| 8 | Baseline health | §3. |
| 9 | Cannot change WhatsApp or Telegram | **Pass.** Code: every `META_*` read and the platform secret are inside `channels/` (Messenger/Instagram code paths); Telegram's send branch never reads them. No WhatsApp file reads them. Tests: worker `aiDisclosureIsolation` (3), `channels.integration` (29, Telegram included), `metaPlatform.integration` (9). |
| 10 | No activation before real credentials | The credentials script (§4) writes them hidden and leaves the flag empty. Activation is a separate step. |

## 3. Baseline (26 Oct 2026, 18:07 UTC, before anything changed)

| Measure | Value |
|---|---|
| Containers | app, worker, postgres healthy |
| WhatsApp | Primary Account CONNECTED, Test CONNECTED, isp AUTHENTICATION_REQUIRED (already, before this work) |
| Messages | 93 in the last 60 minutes; last 24 h: 637 PROCESSED, 27 IGNORED, 0 FAILED |
| Outbound (24 h) | 6 SENT, 0 failed |
| Worker commands (24 h) | 2 DONE |
| Open collection gaps | 0 |
| Channel connections / Meta OAuth sessions | 0 / 0 |

Re-run the same queries after activation and after the test; any worse WhatsApp figure stops the test.

## 4. Activation (in this order)

1. **Deploy** the allowlist release (`DEPLOY.md`: backup → migrate → app → worker). Without it, the flag
   would reach every workspace. **Do not activate on an older build.**
2. **Credentials (platform owner, on the server):**

   ```bash
   cd ~/Support-Message-Automation && bash scripts/meta-gate-b-credentials.sh cmvpjywxv000ol2cjkzkd75r9
   ```

   - The App Secret is typed hidden.
   - The flag stays empty.
   - It prints the webhook verify token for Meta's form.
3. **Activate** (operator):
   - back up the database (`pg_dump`, `~/backups/pre-meta-gate-b-*.sql.gz`);
   - record the baseline again;
   - set `META_INTEGRATION_ENABLED=true`;
   - recreate `app` and `worker`;
   - check:
     - the webhook handshake answers with the right token and 403 with a wrong one;
     - "Connect with Facebook" appears in GetAssistAdmindemo **only**;
     - the NOOR PRO ITV and NOOR VIP settings pages show it as unavailable;
     - WhatsApp reconnects.
4. **Meta dashboard:**
   - Webhooks → Page and Instagram → the callback URL and verify token → Verify and save.
   - Subscribe the fields in 09 §1a.5.

## 5. The 14-step test

09 §2, signed in to `https://demo.getassist.pro` as a login of GetAssistAdmindemo. Record the actual
result of every step here:

| # | Result | Notes |
|---|---|---|
| 1–14 | | |

## 6. Rollback (any problem)

1. On the server, in `.env`:
   - set `META_INTEGRATION_ENABLED=`, empty;
   - or restore the `.env` backup the credentials script printed.
2. Recreate the app and the worker:

   ```bash
   docker compose up -d --no-deps --force-recreate app
   ```

   ```bash
   docker compose up -d --no-deps --force-recreate worker
   ```

   With the flag empty:
   - every Meta button disappears;
   - `/api/meta/webhook` answers 404;
   - the worker sends nothing on one-click connections (it has no app secret).

   Manual connections, WhatsApp and Telegram are unaffected.
3. Optionally remove the test connections in GetAssistAdmindemo → Settings → Messaging Channels →
   Disconnect.
4. Meta dashboard: remove the webhook subscriptions, or leave the app in Development mode, where nobody
   without a role can use it.
5. **The database needs no rollback.** The release has no migration, and gate B writes only:
   - `MetaOAuthSession` and `ChannelConnection` rows in the test workspace;
   - channel conversations and messages in the test workspace.

   Restore the backup only if data outside the test workspace is wrong.
