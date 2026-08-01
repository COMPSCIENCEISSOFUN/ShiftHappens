CREATE TABLE "CertificationDefinition" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CertificationDefinition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CertificationDefinitionDepartment" (
    "certificationDefinitionId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CertificationDefinitionDepartment_pkey" PRIMARY KEY ("certificationDefinitionId", "departmentId")
);

CREATE UNIQUE INDEX "CertificationDefinition_organizationId_name_key"
ON "CertificationDefinition"("organizationId", "name");

CREATE INDEX "CertificationDefinition_organizationId_isActive_idx"
ON "CertificationDefinition"("organizationId", "isActive");

CREATE INDEX "CertificationDefinitionDepartment_departmentId_idx"
ON "CertificationDefinitionDepartment"("departmentId");

ALTER TABLE "CertificationDefinition"
ADD CONSTRAINT "CertificationDefinition_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CertificationDefinitionDepartment"
ADD CONSTRAINT "CertificationDefinitionDepartment_certificationDefinitionId_fkey"
FOREIGN KEY ("certificationDefinitionId") REFERENCES "CertificationDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CertificationDefinitionDepartment"
ADD CONSTRAINT "CertificationDefinitionDepartment_departmentId_fkey"
FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
