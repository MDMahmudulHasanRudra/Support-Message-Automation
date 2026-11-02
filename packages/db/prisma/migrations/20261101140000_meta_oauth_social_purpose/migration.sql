-- Meta expansion A2 (docs/meta-expansion/04 §2): Social Studio's "Connect Facebook / Instagram" goes through
-- the same platform callback, single-use state, browser binding and one-time claim as the messaging
-- "Connect with Facebook". A SOCIAL_CONNECT attempt can only be claimed by the Social Studio claim, and a
-- messaging attempt only by the messaging claim, so a messaging grant never becomes a publishing grant.
--
-- Additive. An enum value cannot be removed in place; unused it is harmless. Pre-use rollback: none needed
-- (no row carries it until the new code starts an attempt).
ALTER TYPE "MetaOAuthPurpose" ADD VALUE IF NOT EXISTS 'SOCIAL_CONNECT';
