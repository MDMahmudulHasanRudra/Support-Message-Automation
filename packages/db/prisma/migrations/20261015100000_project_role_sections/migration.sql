-- Page-level project roles (PROJECT_ROLES.md): which modules and sub-modules a project role opens,
-- Read or Full, and which parts of the Dashboard it shows. Additive: one nullable column; NULL means
-- "no page selection", which is how every existing role (and every global role) keeps behaving.
ALTER TABLE "ProjectRole" ADD COLUMN "sectionAccess" JSONB;

-- Only an object (section id -> level) is meaningful; the app sanitises the contents on every read and write.
ALTER TABLE "ProjectRole" ADD CONSTRAINT "ProjectRole_sectionAccess_object"
  CHECK ("sectionAccess" IS NULL OR jsonb_typeof("sectionAccess") = 'object');
