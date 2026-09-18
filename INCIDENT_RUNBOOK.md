# Incident runbook — "messages stopped arriving"

The failure this exists for has no symptom of its own. An account reports CONNECTED, the worker
heartbeats, every queue drains, the dashboard is green — and not one incoming message is stored.
From the outside that is indistinguishable from a quiet afternoon, which is why the 18 Sep 2026
outage ran for 3 h 15 m before anybody noticed.

**Capture evidence before restarting anything.** A restart is also the fix, so restarting first
destroys the only record of which of the several possible causes it actually was, and the next
occurrence starts from zero again.

---

## 1. Is the worker even alive?

Open **WhatsApp → Accounts** and read two things:

| Reading | Meaning |
|---|---|
| **Worker last seen** older than ~1 minute | The worker process is dead or wedged. Nothing else on this page means anything — go to step 4. |
| **Worker last seen** current, account not CONNECTED | The worker is up and this session is not. The status badge says which kind. |
| **Worker last seen** current, account CONNECTED | The invisible failure. Continue. |

The heartbeat stamps every account every 15 s, so it moves whether or not any session is healthy.
That is the whole reason it can tell "the worker is down" apart from "the worker is up and this
number will not connect" — two situations needing opposite responses.

## 2. What do the logs say?

**System Logs**, from 30 minutes before the last message you did receive. Look for:

- `Connected account is not collecting messages` — the watchdog proved a disagreement between what
  WhatsApp holds and what was stored. This is the smoking gun.
- `Session dropped — reconnecting automatically` / `Automatic reconnect failed`
- Anything from `provider` at ERROR.

On the server, before any restart:

```bash
docker compose ps
```

```bash
docker compose logs worker --since 5h > /tmp/worker-incident.log
```

Then grep that file for the five prefixes that matter — `[watchdog]`, `[registry]`, `[catch-up]`,
`[openwa]`, `[queue]`:

```bash
grep -nE '\[(watchdog|registry|catch-up|openwa|queue)\]' /tmp/worker-incident.log | tail -100
```

Keep the file. It is the input to working out which defect fired.

## 3. Recover the messages

Press **Reconnect** on the affected account.

A successful connect re-attaches the message listener and then runs `catchUpMissedMessages`, which
sweeps back up to `CATCHUP_MAX_LOOKBACK_HOURS` (12) and stores everything WhatsApp still holds for
chats touched in that window.

**Expect records, not replies.** Anything older than `CATCHUP_AUTOMATION_WINDOW_MINUTES` (15) is
stored and deliberately *not* auto-answered. That is correct behaviour and not a second bug: a
reply to this morning's question arriving at lunchtime is worse than silence — a colleague has
very likely answered in the group already — and a burst of them on every restart is exactly the
unprompted bulk sending this product refuses to do.

Nothing is lost by that choice. Recovered messages appear in the chat inbox, count in Team
Performance, and show under "waiting for a reply" if they genuinely were never answered. Escalation
is deliberately not opened for them (a backdated case is instantly overdue and fires its whole
alert ladder at once), but a human reply still closes one.

**If Reconnect does not clear it**, the session needs re-linking with the phone — QR or pairing
code, on the Accounts page. That is the state defect D1 describes: nothing would have told you.

## 4. If the worker itself is wedged

```bash
docker compose restart worker
```

Boot recovery requeues whatever was mid-flight, resets any status left behind by the dead process,
and the catch-up sweep runs after each account connects.

## 5. Afterwards

Deploy the pending migrations — six as of this incident (`ai_sandbox`, `knowledge_builder`,
`candidate_procedure`, `knowledge_verified_default_false`, `team_management_settings`,
`whatsapp_pairing_method`):

```bash
docker compose exec worker sh -c "cd /app/packages/db && npx prisma migrate deploy"
```

Then confirm **WhatsApp → Accounts** and **Team Management → Duty History** both load. A live
`P2022` "column does not exist" is an undeployed migration, not a new bug — check
`_prisma_migrations` before treating it as one.

---

## Why each of these steps exists

Four defects made the silence possible, all of the same shape: every health mechanism in the worker
is pull-based and status-gated, so it asks the database which accounts are CONNECTED, or waits for
a human to open a page. An account that is neither CONNECTED nor DISCONNECTED falls through every
filter, and no push channel existed that could have said so.

- **D1** — `RECONNECTING` was an absorbing state: excluded from auto-recovery, excluded from the
  watchdog, and shown on the dashboard as "The worker is bringing this session back up" while
  nothing was. Only a process restart cleared it.
- **D2** — the watchdog's probe could not fail. `fetchMessagesSince` catches its own enumeration
  failure and returns `[]`, so a browser that could not be queried at all logged "quiet for 195m
  and WhatsApp agrees".
- **D3** — no operational event could raise an alert: `NotificationEvent` had no infrastructure
  member. And the WhatsApp channel resolves through the same registry it would be reporting on.
- **D4** — the heartbeat proved only that one `setInterval` fires. It shares nothing with the other
  twenty loops.

Phase 1 of the reliability work closes all four. Once it is deployed, steps 1 and 2 above should be
replaced by "read the alert you were sent" — this runbook stays for the case where the alerting
itself is what failed.
