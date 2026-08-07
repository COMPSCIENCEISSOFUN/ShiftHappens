-- Task.departmentId: SetNull -> Restrict
--
-- A department-less task means ORG-WIDE work, so nulling the column when a
-- department was deleted made blank mean two different things. A stranded task
-- silently widened eligibility to the whole organisation and switched seniority
-- from per-department to org-wide, with nothing saying it had happened.
--
-- Same ambiguity 20260805000000_work_rule_targets_restrict removed for work
-- rules. Departments already archive properly and already refuse deletion while
-- they hold members or work rules; tasks were the one attachment that gave way.
--
-- Idempotent: the constraint is dropped only if present, so this is safe to run
-- against a database that has already had it applied by hand.

ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "Task_departmentId_fkey";

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
