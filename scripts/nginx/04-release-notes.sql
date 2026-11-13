-- Product name in the two published release notes (revisions are history and stay as they were).
BEGIN;
UPDATE "ReleaseNote" SET
  title = replace(title, 'Get Assist', 'Chithii'),
  summary = replace(summary, 'Get Assist', 'Chithii'),
  "whatsNew" = string_to_array(replace(array_to_string("whatsNew", chr(31)), 'Get Assist', 'Chithii'), chr(31)),
  improvements = string_to_array(replace(array_to_string(improvements, chr(31)), 'Get Assist', 'Chithii'), chr(31)),
  "technicalNotes" = string_to_array(replace(array_to_string("technicalNotes", chr(31)), 'Get Assist', 'Chithii'), chr(31))
WHERE version IN ('0.25.0', '0.30.0');
SELECT version, title FROM "ReleaseNote" WHERE row_to_json("ReleaseNote".*)::text ILIKE '%get assist%';
COMMIT;
