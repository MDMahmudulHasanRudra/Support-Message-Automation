-- MULTI-PROJECT, PHASE 7: parent/child project integrity in the database. See MULTI_PROJECT_PLAN.md
-- §6.5 and §10.7.
--
-- Every project-owned row carries its own "projectId" (§3), and until now only the application kept
-- it equal to its parent's: the scoped Prisma clients, the raw-SQL filters and the send-time account
-- check. This makes the database refuse the inconsistency itself, so a bug no test anticipated still
-- cannot store, say, a Bizify message on an ISP Digital account.
--
--   1. The data is VERIFIED first. For every single-column foreign key between two project-owned
--      tables, any row whose parent belongs to another project stops the migration with a message
--      naming the table, the column and the count. Nothing is changed before that check passes.
--   2. A consistency trigger is added on each such foreign key: inserting or updating a row whose
--      parent is in another project raises foreign_key_violation. A NULL reference, or a parent that
--      does not exist (which the ordinary foreign key already reports), is left to the foreign key.
--   3. "projectId" becomes immutable on all project-owned tables: once a row belongs to a project it
--      stays there. Without this a parent could be moved after its children were checked.
--
-- Triggers rather than composite foreign keys, deliberately. The plan's §6.5 sketch is a composite
-- `(parentId, projectId) → parent(id, projectId)` key; the guarantee is the same, but Prisma owns this
-- schema's foreign keys, and a composite key it does not model would be proposed for DROP by the next
-- `prisma migrate dev` — the protection would be one careless command from disappearing. Prisma does
-- not introspect triggers, so these stay. The ON DELETE behaviour of every existing foreign key is
-- untouched (a SET NULL still nulls only the reference column, which a composite key could not).
--
-- The foreign keys are read from the catalog rather than listed here, so the set is exactly what the
-- database has. A relation added later needs its own trigger; the test
-- `projectIntegrity.integration.test.ts` compares the catalog with the triggers and fails if one is
-- missing.
--
-- Cost: step 1 reads each child table once (Message several times, once per reference). Steps 2 and
-- 3 are metadata only. Each later insert pays one primary-key lookup per non-null reference.

CREATE OR REPLACE FUNCTION enforce_same_project() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_table text := TG_ARGV[0];
  fk_column text := TG_ARGV[1];
  fk_value text;
  parent_project text;
BEGIN
  EXECUTE format('SELECT ($1).%I::text', fk_column) INTO fk_value USING NEW;
  IF fk_value IS NULL THEN
    RETURN NULL;
  END IF;
  EXECUTE format('SELECT "projectId" FROM %I WHERE "id" = $1', parent_table) INTO parent_project USING fk_value;
  IF parent_project IS NOT NULL AND parent_project <> NEW."projectId" THEN
    RAISE EXCEPTION 'Cross-project reference refused: %.% points at a % in project %, but the row belongs to project %',
      TG_TABLE_NAME, fk_column, parent_table, parent_project, NEW."projectId"
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_project_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."projectId" IS DISTINCT FROM OLD."projectId" THEN
    RAISE EXCEPTION 'A row cannot move between projects: %.projectId is % and cannot become %',
      TG_TABLE_NAME, OLD."projectId", NEW."projectId"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  fk record;
  bad bigint;
  scoped record;
BEGIN
  -- 1 + 2: every single-column foreign key from one project-owned table to another.
  FOR fk IN
    SELECT child.relname AS child_table, att.attname AS fk_column, parent.relname AS parent_table
    FROM pg_constraint c
    JOIN pg_class child ON child.oid = c.conrelid
    JOIN pg_class parent ON parent.oid = c.confrelid
    JOIN pg_namespace ns ON ns.oid = child.relnamespace AND ns.nspname = current_schema()
    JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND array_length(c.conkey, 1) = 1
      AND att.attname <> 'projectId'
      AND parent.relname <> 'Project'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'projectId' AND NOT a.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'projectId' AND NOT a.attisdropped)
      -- SystemLog's projectId is optional (platform events carry none); it has no such references.
      AND child.relname <> 'SystemLog'
    ORDER BY 1, 2
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I c JOIN %I p ON p."id" = c.%I WHERE p."projectId" <> c."projectId"',
      fk.child_table, fk.parent_table, fk.fk_column
    ) INTO bad;
    IF bad > 0 THEN
      RAISE EXCEPTION '% row(s) of %.% reference a % in another project; fix them before this migration runs',
        bad, fk.child_table, fk.fk_column, fk.parent_table;
    END IF;

    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE OF %I, "projectId" ON %I FOR EACH ROW EXECUTE FUNCTION enforce_same_project(%L, %L)',
      fk.child_table || '_' || fk.fk_column || '_same_project', fk.fk_column, fk.child_table, fk.parent_table, fk.fk_column
    );
  END LOOP;

  -- 3: projectId never changes, on every project-owned table.
  FOR scoped IN
    SELECT cls.relname AS table_name
    FROM pg_attribute a
    JOIN pg_class cls ON cls.oid = a.attrelid AND cls.relkind = 'r'
    JOIN pg_namespace ns ON ns.oid = cls.relnamespace AND ns.nspname = current_schema()
    WHERE a.attname = 'projectId' AND NOT a.attisdropped AND cls.relname <> 'SystemLog'
    ORDER BY 1
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OF "projectId" ON %I FOR EACH ROW EXECUTE FUNCTION enforce_project_immutable()',
      scoped.table_name || '_projectId_immutable', scoped.table_name
    );
  END LOOP;
END;
$$;
