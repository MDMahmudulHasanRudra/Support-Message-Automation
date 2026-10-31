# Social Studio — licences and provenance

## Decision

Social Studio is an original Get Assist implementation. Postiz (AGPL-3.0,
https://github.com/gitroomhq/postiz-app) is a **product reference only**.

## What happened, in order

1. **Postiz API research.** A first foundation (local branch `checkpoint/social-studio-postiz`, commit
   `2d9f3ed`, never pushed or merged) called the Postiz public HTTP API. To learn its contract, the
   following Postiz files at tag v2.25.3 were READ (not copied):
   - the public API controller;
   - the auth middleware;
   - the throttler;
   - the post and media DTOs;
   - the OAuth service;
   - the webhook sender;
   - the Prisma schema's Post / Integration / Media models;
   - docker-compose.
2. **The owner decided to build natively.** All Postiz-specific code was removed from the working tree
   before anything was committed to `rudra`. What `rudra` contains was written from:
   - Get Assist's own existing code (workflow, Meta helpers, media storage, permissions);
   - Meta's official Graph API and Instagram Content Publishing documentation;
   - general knowledge of how social schedulers work.
3. **No Postiz material on `rudra`.** No Postiz code, UI, CSS, asset, branding, schema or provider
   implementation is in `rudra`. The Social Studio schema is Get Assist's own design (one job per account
   with attempts, approval hashes, project-integrity triggers), unlike Postiz's.

## Dependencies

- **None added.** The module uses packages already in the repository:
  - Next.js, React, Prisma;
  - `lucide-react` icons (ISC);
  - Node's `crypto` / `fetch`;
  - `@support-automation/*` workspace packages.
- **No platform SDK**: every platform call is plain HTTPS to the official API.

## For legal review

- **The research checkpoint branch**: it exists only on the developer's machine and contains a client
  for Postiz's HTTP API (calling an API is not copying it). It can be deleted:
  `git branch -D checkpoint/social-studio-postiz`.
- **Product overlap**: Social Studio's feature list overlaps with many products in the category
  (scheduling, calendar, approvals, media library). These are common, unprotectable product ideas; the
  implementation and interface are Get Assist's own.
- **Platform terms**:
  - Meta: Platform Terms, Developer Policies, App Review for `pages_manage_posts` /
    `instagram_content_publish`.
  - Each future network: its own developer terms and review.
  - These must be accepted by the platform owner before customers use the feature.
