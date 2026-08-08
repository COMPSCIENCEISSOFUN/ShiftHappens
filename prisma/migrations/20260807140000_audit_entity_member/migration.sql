-- Consolidate AuditLog.entityType "membership" onto "member".
--
-- Both were in use for what a reader considers one thing: invitations and role
-- changes wrote "member", while seniority overrides, availability-review
-- requests and contracted-days changes wrote "membership". The audit page's
-- filter offers "Members", which maps to "member" — so choosing it silently hid
-- half the entries about people.
--
-- The code now writes only "member" and the type system enforces it. This
-- brings existing rows across; without it those entries would stay unreachable
-- by exactly the filter this change exists to fix.
--
-- "auto-schedule" is corrected in the same pass. It was the only hyphenated
-- value, and it named the FEATURE rather than the thing acted on — the rows it
-- tagged are assignment writes, raised with action "task.assigned".
--
-- Both statements are idempotent: re-running matches nothing.
UPDATE "AuditLog" SET "entityType" = 'member' WHERE "entityType" = 'membership';
UPDATE "AuditLog" SET "entityType" = 'assignment' WHERE "entityType" = 'auto-schedule';
