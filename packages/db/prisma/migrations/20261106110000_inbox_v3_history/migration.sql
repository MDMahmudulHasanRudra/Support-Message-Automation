-- Unified Inbox V3, part 2: priority and tag changes are recorded in the conversation history
-- (feature UNIFIED_INBOX_V3). Only the event-kind CHECK changes; no column, no data.
ALTER TABLE "ConversationEvent" DROP CONSTRAINT "ConversationEvent_kind_known";
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_kind_known" CHECK ("kind" IN ('ASSIGNEE', 'TEAM', 'STATUS', 'REOPEN', 'PENDING', 'RESOLVE', 'SNOOZE', 'UNSNOOZE', 'PRIORITY', 'TAGS'));
