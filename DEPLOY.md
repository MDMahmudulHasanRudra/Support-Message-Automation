# Deploying — read this every time

> ## ⚠️ Every deploy must run the database migrations FIRST
>
> New code often needs new database columns. If the code is deployed without its migrations, pages
> and the worker fail with `P2022 … column does not exist`. **The worker can stop storing messages.**
>
> `docker compose up -d --no-deps …` **SKIPS migrations**: `--no-deps` also skips the `migrate`
> service that `app` normally waits for. That is exactly how they were missed on 17 Oct 2026.

## The deploy, in order (on the server, in `~/Support-Message-Automation`)

```bash
# 1. Get the code
git pull

# 2. Back up the database (keep it until the deploy is verified)
mkdir -p ~/backups
docker compose exec -T postgres sh -c 'pg_dump -U $POSTGRES_USER -d $POSTGRES_DB' \
  | gzip > ~/backups/pre-deploy-$(git rev-parse --short HEAD)-$(date -u +%Y%m%d-%H%M).sql.gz

# 3. See which migrations are waiting (read-only)
docker compose build migrate
docker compose run --rm --entrypoint "npx prisma migrate status" migrate

# 4. RUN THE MIGRATIONS — never skip this step, even if you think nothing changed
docker compose run --rm migrate

# 5. Rebuild and restart the dashboard
docker compose up -d --build --no-deps --force-recreate app

# 6. Rebuild and restart the worker — reconnects every WhatsApp session for a few minutes,
#    so pick a quiet time. Deploy it in the same window as the app when the change touches both.
docker compose up -d --build --no-deps --force-recreate worker

# 7. Verify
docker compose ps                                                     # app, worker, postgres healthy
docker compose run --rm --entrypoint "npx prisma migrate status" migrate   # "Database schema is up to date!"
docker compose logs --since 10m app worker | grep -i "P2022\|does not exist"   # must print nothing
```

**Shortcut:** `docker compose up -d --build` (with NO `--no-deps`) runs `migrate` automatically before
`app`. Use the step-by-step version above when you only want to restart some containers.

## Checks that catch a mistake

- **The images really are new.** `docker compose images` shows when each was CREATED. A `git pull`
  without a rebuild leaves the old images running (also seen on 17 Oct 2026).
- **The last migration in the repo is the last one applied.** Compare:
  - `ls packages/db/prisma/migrations | tail -1` (what the code expects);
  - `docker compose exec -T postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT migration_name FROM _prisma_migrations ORDER BY started_at DESC LIMIT 1"'` (what the database has).
- **A live `P2022` after a deploy** is almost always a migration that did not run. Run step 4. Do not
  roll the code back first.

## Migrations are additive here

Every migration in this repository only adds tables, columns, indexes or enum values. They are written
so that the OLD code keeps running on the NEW schema. Running migrations before the new images start
is therefore always safe, and it is the required order: migrate, then app, then worker. Each
migration's own header says how to roll it back, if it ever has to be.

## Rolling back

- **Code:** check out the previous commit and repeat steps 5–6. The migrated schema works with the
  old code.
- **Database:** restore the step-2 backup only if data itself is wrong. Never restore just to undo a
  migration; roll forward instead.
