# 09 - Performance and scale (as built)

Release 1 adds no table, no column, no index and no background loop (03, 11). Everything below is
computed at request time from `Message`, exactly like the group Team Report it extends. This file records
what was measured, the bounds that keep a request cheap, and where the first limit would appear.

## Measured

`phase2ReportBenchmark.integration.test.ts` (isolated Postgres, synthetic rows):

| Case | Fixture | Result |
|---|---|---|
| Group report, 31 days | 180,000 group rows | within the existing budget, unchanged by this release |
| Personal report, 31 days (WP6) | 2,000 personal chats, 8,000 rows, beside the 180,000 group rows | 1.3 s for the month |
| Earlier-message probe (a conversation's last message before the period) | one probe per chat | `Message_personal_chat_idx`, Index Scan Backward, 0.013 ms per chat, execution 2.3 ms |

The personal read is bounded by the project, the personal-chat predicate (`PERSONAL_CHAT_SQL`, the SQL form of
`isPersonalChatId`) and the period's timestamp range. No new index was needed, so the `Message` index
proposal in 03 section 3 stays deferred.

## Bounds that exist on purpose

| Bound | Value | Where |
|---|---|---|
| Custom report range | 92 days | `resolveTeamReportRange` (unchanged) |
| Groups in a filter | 200 | `MAX_FILTER_GROUPS` (unchanged) |
| Context before the period / look-ahead after | 4 h / 24 h | `CONTEXT_MS`, `LOOKAHEAD_MS` (now exported and printed in Run information) |
| Customer-specific replies | a reply is linked only inside 4 h of the ask | `replyAttribution.ts` |
| Identity preview look-back | 92 days by default, at most 365 | `PREVIEW_DEFAULT_DAYS`, `PREVIEW_MAX_DAYS` |
| Identity preview logical messages | 20,000, then `truncated: true` and a notice | `PREVIEW_MAX_LOGICAL` |
| Identity preview KPI estimate | the 200 most-changed groups of the latest impacted month | `PREVIEW_MAX_KPI_GROUPS` |

## The identity preview's cost

Two raw queries, both naming `"projectId"`:

1. **Hits.** `senderPhone = ANY(identifiers)` over the window, grouped by chat and logical key. It reads the
   `Message_senderPhone_timestampWa_idx` index. A busy sender is bounded by `LIMIT 20,001`.
2. **Copies.** Every stored copy of those messages, joined from the hit list by chat, time (plus or minus
   2 s) and logical key (`Message_chatId_timestampWa_idx`), with the same `outboundByKeyJoin` the reports use.

The classification itself is two passes of the shared classifier over the result: CPU only. The KPI estimate
then runs the month report twice (roster before, roster after) for the affected groups, and the personal
report twice when the viewer may see personal chats; it is the heaviest part and the reason the group list is
capped. The preview is a Server Action pressed by a person; nothing polls it.

The preview's own two queries select no message body. The KPI estimate re-runs the reports, which read the same
short, pre-filtered text fragments they always read for the human-only wait; none of it leaves the server.

## Where the first limit will appear

1. A very large personal roster on one account: the personal report reads every personal row in the period and
   its context. If the month report exceeds the benchmark budget, the answer is the partial index on
   `("projectId","timestampWa") WHERE "groupId" IS NULL` (03 section 3), applied with `CREATE INDEX
   CONCURRENTLY` outside Prisma's transaction, then a nightly rollup only if that is not enough. The "wait"
   definition must stay the Team Report's.
2. A sender who wrote more than 20,000 logical messages in the window: the preview says so and shows the most
   recent ones. Narrow the look-back (`days`) rather than raising the cap.
3. Combined scope loads the group and personal reports concurrently (`Promise.all`); it costs about their sum in
   database work, and each half is exactly the report it would be alone.
