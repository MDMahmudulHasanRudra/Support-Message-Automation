-- Client CRM & Billing V7 (CLIENT_CRM_V7.md §6). A new email purpose for messages to clients. Its own migration:
-- PostgreSQL cannot use a value added by ALTER TYPE ... ADD VALUE inside the transaction that added it.
-- Rollback: a value cannot be removed from an enum in place; it is harmless while unused.
ALTER TYPE "EmailPurpose" ADD VALUE 'CLIENT_MESSAGE';
