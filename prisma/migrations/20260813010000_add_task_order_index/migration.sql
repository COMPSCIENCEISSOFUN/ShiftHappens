-- Running order for work items within a project.
--
-- Presentation only. It does not block, gate or defer anything: allocation,
-- eligibility and scheduling all ignore it, and an item ordered third is
-- staffed when its own dates say so rather than after the two above it.
--
-- Defaults to 0 for every existing row, so ordering falls through to the
-- scheduledStart/createdAt tiebreak the project view already used and nothing
-- moves until somebody reorders it.
ALTER TABLE "Task" ADD COLUMN "orderIndex" INTEGER NOT NULL DEFAULT 0;

-- The project view sorts by this first, so it is worth an index alongside the
-- projectId lookup that precedes it.
CREATE INDEX "Task_projectId_orderIndex_idx" ON "Task"("projectId", "orderIndex");
