CREATE TABLE "ProjectDepartment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectDepartment_pkey" PRIMARY KEY ("id")
);

INSERT INTO "ProjectDepartment" ("id", "projectId", "departmentId", "createdAt")
SELECT 'legacy_' || "id", "id", "departmentId", CURRENT_TIMESTAMP
FROM "Project"
WHERE "departmentId" IS NOT NULL;

CREATE UNIQUE INDEX "ProjectDepartment_projectId_departmentId_key" ON "ProjectDepartment"("projectId", "departmentId");
CREATE INDEX "ProjectDepartment_departmentId_idx" ON "ProjectDepartment"("departmentId");

ALTER TABLE "ProjectDepartment" ADD CONSTRAINT "ProjectDepartment_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectDepartment" ADD CONSTRAINT "ProjectDepartment_departmentId_fkey"
FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
