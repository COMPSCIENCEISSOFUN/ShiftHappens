/**
 * Demo data for a project-based IT company.
 *
 * Idempotent: safe to run repeatedly without duplicating users, departments,
 * certifications or tasks.
 *
 * Run with: npm exec -- tsx prisma/seed-it-demo.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();
type Tx = Prisma.TransactionClient;

const PASSWORD = "TestPass1!";
const ORG_SLUG = "northstar-it-solutions";

async function user(tx: Tx, email: string, name: string, password: string) {
  const hashedPassword = await bcrypt.hash(password, 12);
  return tx.user.upsert({
    where: { email },
    update: { name, hashedPassword, emailVerified: new Date() },
    create: { email, name, hashedPassword, emailVerified: new Date() },
  });
}

async function department(tx: Tx, organizationId: string, name: string, description: string, color: string) {
  return tx.department.upsert({
    where: { organizationId_name: { organizationId, name } },
    update: { description, color, archivedAt: null },
    create: { organizationId, name, description, color },
  });
}

async function membership(tx: Tx, userId: string, organizationId: string, role: string, employmentType?: string) {
  return tx.membership.upsert({
    where: { userId_organizationId: { userId, organizationId } },
    update: { role, status: "active", employmentType: role === "staff" ? employmentType ?? "casual" : null },
    create: { userId, organizationId, role, status: "active", employmentType: role === "staff" ? employmentType ?? "casual" : null },
  });
}

async function assignDepartment(tx: Tx, membershipId: string, departmentId: string) {
  await tx.departmentMembership.upsert({
    where: { membershipId_departmentId: { membershipId, departmentId } },
    update: {},
    create: { membershipId, departmentId },
  });
}

async function seed() {
  await prisma.$transaction(async (tx) => {
    const adminUser = await user(tx, "admin@northstarit.com", "Jordan Patel", PASSWORD);
    const organization = await tx.organization.upsert({
      where: { slug: ORG_SLUG },
      update: {
        name: "Northstar IT Solutions",
        industry: "Information Technology",
        description: "A project-based IT consultancy delivering cloud, software and security work.",
        subscriptionTier: "pro",
        status: "active",
      },
      create: {
        name: "Northstar IT Solutions",
        slug: ORG_SLUG,
        industry: "Information Technology",
        description: "A project-based IT consultancy delivering cloud, software and security work.",
        subscriptionTier: "pro",
      },
    });

    const adminMembership = await membership(tx, adminUser.id, organization.id, "company_admin");

    const departments = {
      engineering: await department(tx, organization.id, "Product Engineering", "Application delivery, APIs and software projects", "#6366F1"),
      cloud: await department(tx, organization.id, "Cloud & DevOps", "Infrastructure, deployment and reliability operations", "#0EA5E9"),
      delivery: await department(tx, organization.id, "Client Delivery", "Implementation, discovery and client project coordination", "#10B981"),
      security: await department(tx, organization.id, "Security & QA", "Security reviews, testing and compliance delivery", "#F97316"),
    };

    const priyaUser = await user(tx, "priya@northstarit.com", "Priya Nair", PASSWORD);
    const priyaMembership = await membership(tx, priyaUser.id, organization.id, "manager");
    await assignDepartment(tx, priyaMembership.id, departments.engineering.id);
    await assignDepartment(tx, priyaMembership.id, departments.delivery.id);

    const danielUser = await user(tx, "daniel@northstarit.com", "Daniel Wong", PASSWORD);
    const danielMembership = await membership(tx, danielUser.id, organization.id, "manager");
    await assignDepartment(tx, danielMembership.id, departments.cloud.id);

    const staffDefinitions = [
      { email: "maya@northstarit.com", name: "Maya Chen", depts: [departments.engineering], certs: ["AWS Certified Developer", "Secure Coding"] },
      { email: "leo@northstarit.com", name: "Leo Martins", depts: [departments.engineering, departments.delivery], certs: ["AWS Certified Developer", "Project Management"] },
      { email: "sophia@northstarit.com", name: "Sophia Lim", depts: [departments.cloud], certs: ["AWS Solutions Architect", "Kubernetes Administrator"] },
      { email: "ethan@northstarit.com", name: "Ethan Brooks", depts: [departments.cloud, departments.security], certs: ["AWS Solutions Architect", "Security+", "Kubernetes Administrator"] },
      { email: "nora@northstarit.com", name: "Nora Ibrahim", depts: [departments.delivery], certs: ["Project Management", "Secure Coding"] },
      { email: "oliver@northstarit.com", name: "Oliver Smith", depts: [departments.security], certs: ["Security+", "QA Automation"] },
      { email: "ava@northstarit.com", name: "Ava Wilson", depts: [departments.engineering, departments.security], certs: ["QA Automation", "Secure Coding"] },
    ];

    const staff: { membershipId: string; name: string }[] = [];
    for (const item of staffDefinitions) {
      const staffUser = await user(tx, item.email, item.name, PASSWORD);
      const staffMembership = await membership(tx, staffUser.id, organization.id, "staff", "full_time");
      staff.push({ membershipId: staffMembership.id, name: item.name });
      for (const dept of item.depts) await assignDepartment(tx, staffMembership.id, dept.id);

      await tx.availability.deleteMany({ where: { membershipId: staffMembership.id } });
      await tx.availability.createMany({
        data: Array.from({ length: 5 }, (_, index) => ({
          membershipId: staffMembership.id,
          dayOfWeek: index + 1,
          startTime: "09:00",
          endTime: "17:30",
          isAvailable: true,
        })),
      });

      for (const certName of item.certs) {
        await tx.certification.upsert({
          where: { id: `${staffMembership.id}-${certName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` },
          update: { name: certName, status: "verified", issuedDate: new Date("2025-01-15"), expiryDate: new Date("2027-01-15"), verifiedById: adminUser.id, verifiedAt: new Date("2025-01-20") },
          create: { id: `${staffMembership.id}-${certName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, membershipId: staffMembership.id, name: certName, status: "verified", issuedDate: new Date("2025-01-15"), expiryDate: new Date("2027-01-15"), verifiedById: adminUser.id, verifiedAt: new Date("2025-01-20") },
        });
      }
    }

    const certificationRequirements = [
      { name: "AWS Certified Developer", description: "Application development on AWS", departments: [departments.engineering.id], required: true },
      { name: "AWS Solutions Architect", description: "Cloud architecture and infrastructure delivery", departments: [departments.cloud.id], required: true },
      { name: "Security+", description: "Baseline cybersecurity qualification", departments: [departments.security.id], required: true },
      { name: "Project Management", description: "Project planning and client delivery coordination", departments: [departments.delivery.id], required: false },
      { name: "QA Automation", description: "Automated quality assurance testing", departments: [departments.security.id, departments.engineering.id], required: false },
    ];
    for (const item of certificationRequirements) {
      const definition = await tx.certificationDefinition.upsert({
        where: { organizationId_name: { organizationId: organization.id, name: item.name } },
        update: { description: item.description, isActive: true },
        create: { organizationId: organization.id, name: item.name, description: item.description, isActive: true },
      });
      for (const departmentId of item.departments) {
        await tx.certificationDefinitionDepartment.upsert({
          where: { certificationDefinitionId_departmentId: { certificationDefinitionId: definition.id, departmentId } },
          update: { isRequired: item.required },
          create: { certificationDefinitionId: definition.id, departmentId, isRequired: item.required },
        });
      }
    }

    await tx.companySettings.upsert({
      where: { organizationId: organization.id },
      update: { allocationMode: "auto", breakRuleHoursWorked: 6, breakRuleBreakHours: 1, operatingHoursStart: 8, operatingHoursEnd: 18 },
      create: { organizationId: organization.id, allocationMode: "auto", breakRuleHoursWorked: 6, breakRuleBreakHours: 1, operatingHoursStart: 8, operatingHoursEnd: 18 },
    });

    const rules = [
      { name: "Consultancy daily limit", type: "max_hours_daily", maxHours: 9 },
      { name: "Consultancy weekly limit", type: "max_hours_weekly", maxHours: 45 },
      { name: "Required recovery break", type: "break_interval", hoursThreshold: 6, breakHours: 1 },
    ];
    for (const rule of rules) {
      await tx.workRule.upsert({
        where: { organizationId_name: { organizationId: organization.id, name: rule.name } },
        update: { type: rule.type, maxHours: rule.maxHours ?? null, hoursThreshold: rule.hoursThreshold ?? null, breakHours: rule.breakHours ?? null, isActive: true },
        create: { organizationId: organization.id, name: rule.name, type: rule.type, maxHours: rule.maxHours ?? null, hoursThreshold: rule.hoursThreshold ?? null, breakHours: rule.breakHours ?? null },
      });
    }

    const projectTasks = [
      { key: "atlas-discovery", title: "Atlas CRM discovery workshop", description: "Map client workflows and turn discovery notes into an implementation backlog.", departmentId: departments.delivery.id, priority: "high", headcount: 2, days: 1, status: "open" },
      { key: "atlas-api", title: "Atlas CRM API integration", description: "Build and test the customer data integration for the Atlas rollout.", departmentId: departments.engineering.id, priority: "high", headcount: 2, days: 2, status: "open" },
      { key: "cloud-migration", title: "Northwind cloud migration runbook", description: "Prepare a rollback-aware migration runbook for the production environment.", departmentId: departments.cloud.id, priority: "medium", headcount: 1, days: 3, status: "open" },
      { key: "security-review", title: "Atlas security review", description: "Review the integration threat model and document remediation actions.", departmentId: departments.security.id, priority: "urgent", headcount: 1, days: 4, status: "open" },
      { key: "completed-portal", title: "Harbor portal release validation", description: "Completed regression validation for the client portal release.", departmentId: departments.security.id, priority: "medium", headcount: 1, days: -3, status: "completed" },
    ];

    for (const item of projectTasks) {
      const start = new Date();
      start.setDate(start.getDate() + item.days);
      start.setHours(9, 0, 0, 0);
      const end = new Date(start);
      end.setHours(12, 0, 0, 0);
      const existing = await tx.task.findFirst({ where: { organizationId: organization.id, title: item.title } });
      const task = existing ?? await tx.task.create({
        data: {
          title: item.title,
          description: item.description,
          instructions: "Update the project board with decisions, blockers and the next owner before closing the task.",
          organizationId: organization.id,
          departmentId: item.departmentId,
          priority: item.priority,
          requiredHeadcount: item.headcount,
          scheduledStart: start,
          scheduledEnd: end,
          status: item.status,
          createdById: item.departmentId === departments.cloud.id ? danielUser.id : priyaUser.id,
        },
      });

      if (item.status === "completed" && !await tx.taskAssignment.findFirst({ where: { taskId: task.id } })) {
        const assignee = staff.find((member) => member.name === "Oliver Smith") ?? staff[0];
        await tx.taskAssignment.create({ data: { taskId: task.id, membershipId: assignee.membershipId, assignedById: adminUser.id, status: "completed", clockInTime: start, clockOutTime: end } });
      }
    }

    // Keep the admin referenced so the seed remains explicit about ownership.
    void adminMembership;
    console.log("Northstar IT Solutions demo seeded");
    console.log("Admin:   admin@northstarit.com / TestPass1!");
    console.log("Manager: priya@northstarit.com / TestPass1! (Product Engineering + Client Delivery)");
    console.log("Manager: daniel@northstarit.com / TestPass1! (Cloud & DevOps)");
    console.log("Staff:   maya@northstarit.com, leo@northstarit.com, sophia@northstarit.com, ethan@northstarit.com, nora@northstarit.com, oliver@northstarit.com, ava@northstarit.com / TestPass1!");
  }, { maxWait: 30000, timeout: 120000 });
}

seed()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
