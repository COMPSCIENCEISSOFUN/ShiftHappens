/**
 * Demo Data Seed Script
 *
 * Creates realistic demo data for the Ocean Grill demo organization.
 * Fully idempotent — safe to run repeatedly on any database state.
 *
 * All queries run inside a single interactive $transaction so that
 * PgBouncer (Supabase) keeps one backend connection throughout,
 * avoiding "prepared statement already exists" errors.
 *
 * Data created:
 * - 1 Company Admin (admin@oceangrill.com)
 * - 2 Managers (with department assignments)
 * - 8 Staff members (with department assignments + employment types)
 * - 3 Departments (with colors)
 * - 5 upcoming tasks (tomorrow)
 * - 15+ historical completed tasks (past 7 days)
 * - Completed assignments with clock in/out data
 * - Rejected assignments (for AI rejection pattern detection)
 * - Availability schedules
 * - Certifications across the whole lifecycle — awaiting review, verified,
 *   expiring, expired, rejected and revoked — so the review workflow is
 *   visible in a demo rather than just its finished state
 * - Company settings
 * - Work rules
 * - 1 Platform Admin (platform@smarttask.com)
 *
 * Run with: npx tsx prisma/seed-demo.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

type Tx = Prisma.TransactionClient;

async function seedAll(tx: Tx) {
  console.log("Seeding demo data...");

  const hashedPassword = await bcrypt.hash("TestPass1!", 12);

  // ============================================================
  // Admin user + Organization (upsert — always correct state)
  // ============================================================
  const adminUser = await tx.user.upsert({
    where: { email: "admin@oceangrill.com" },
    update: {
      name: "Darryn Wan",
      hashedPassword,
      emailVerified: new Date(),
    },
    create: {
      name: "Darryn Wan",
      email: "admin@oceangrill.com",
      hashedPassword,
      emailVerified: new Date(),
    },
  });

  let org = await tx.organization.findUnique({
    where: { slug: "ocean-grill" },
  });
  if (!org) {
    org = await tx.organization.create({
      data: {
        name: "Ocean Grill",
        slug: "ocean-grill",
        industry: "Hospitality",
        description: "A beachside restaurant and bar",
      },
    });
  }

  // Ensure admin membership exists and is correct
  const adminMembership = await tx.membership.upsert({
    where: {
      userId_organizationId: {
        userId: adminUser.id,
        organizationId: org.id,
      },
    },
    update: { role: "company_admin", status: "active" },
    create: {
      userId: adminUser.id,
      organizationId: org.id,
      role: "company_admin",
      status: "active",
    },
  });

  const orgId = org.id;

  // Set subscription tier for demo (Pro enables all features except audit log)
  await tx.organization.update({
    where: { id: orgId },
    data: { subscriptionTier: "pro" },
  });
  console.log("Admin user, organization, and Pro tier ready");

  // ============================================================
  // Departments
  // ============================================================
  const departments: { id: string; name: string; color: string }[] = [];
  const deptNames = [
    { name: "Kitchen", description: "Food preparation and cooking", color: "#EF4444" },
    { name: "Bar", description: "Beverage service and cocktails", color: "#3B82F6" },
    { name: "Front of House", description: "Guest service, hosting, and dining room", color: "#10B981" },
  ];

  for (const dept of deptNames) {
    const existing = await tx.department.findUnique({
      where: { organizationId_name: { organizationId: orgId, name: dept.name } },
    });
    if (existing) {
      await tx.department.update({
        where: { id: existing.id },
        data: { color: dept.color },
      });
      departments.push({ id: existing.id, name: existing.name, color: dept.color });
    } else {
      const created = await tx.department.create({
        data: { ...dept, organizationId: orgId },
      });
      departments.push({ id: created.id, name: created.name, color: dept.color });
    }
  }

  console.log(`Created ${departments.length} departments`);

  // ============================================================
  // Managers
  // ============================================================
  const managers = [
    { name: "Sarah Chen", email: "sarah@oceangrill.com", dept: "Kitchen" },
    { name: "Marcus Johnson", email: "marcus@oceangrill.com", dept: "Bar" },
  ];

  // Captured so certification reviews can be attributed to a manager rather
  // than always the company admin — the "Reviewed by" line on a certification
  // card is otherwise the same name on every row, which reads like a stub.
  const managerUserIds: Record<string, string> = {};

  for (const mgr of managers) {
    const user = await tx.user.upsert({
      where: { email: mgr.email },
      update: { name: mgr.name, hashedPassword, emailVerified: new Date() },
      create: {
        name: mgr.name,
        email: mgr.email,
        hashedPassword,
        emailVerified: new Date(),
      },
    });

    const membership = await tx.membership.upsert({
      where: {
        userId_organizationId: { userId: user.id, organizationId: orgId },
      },
      update: { role: "manager", status: "active" },
      create: {
        userId: user.id,
        organizationId: orgId,
        role: "manager",
        status: "active",
      },
    });

    managerUserIds[mgr.name] = user.id;

    const dept = departments.find((d) => d.name === mgr.dept);
    if (dept) {
      const existing = await tx.departmentMembership.findUnique({
        where: { membershipId_departmentId: { membershipId: membership.id, departmentId: dept.id } },
      });
      if (!existing) {
        await tx.departmentMembership.create({
          data: { membershipId: membership.id, departmentId: dept.id },
        });
      }
    }
  }

  console.log("Created 2 managers");

  // ============================================================
  // Staff
  // ============================================================
  const staffMembers = [
    { name: "Alex Rivera", email: "alex@oceangrill.com" },
    { name: "Jamie Park", email: "jamie@oceangrill.com" },
    { name: "Taylor Smith", email: "taylor@oceangrill.com" },
    { name: "Jordan Lee", email: "jordan@oceangrill.com" },
    { name: "Casey Brown", email: "casey@oceangrill.com" },
  ];

  const staffMembershipIds: string[] = [];

  for (const staff of staffMembers) {
    const user = await tx.user.upsert({
      where: { email: staff.email },
      update: { name: staff.name, hashedPassword, emailVerified: new Date() },
      create: {
        name: staff.name,
        email: staff.email,
        hashedPassword,
        emailVerified: new Date(),
      },
    });

    const isTemporaryPartTime = ["Alex Rivera", "Jamie Park", "Taylor Smith"].includes(staff.name);

    const membership = await tx.membership.upsert({
      where: {
        userId_organizationId: { userId: user.id, organizationId: orgId },
      },
      update: {
        role: "staff",
        status: "active",
        employmentType: isTemporaryPartTime ? "temporary_part_time" : "casual",
      },
      create: {
        userId: user.id,
        organizationId: orgId,
        role: "staff",
        status: "active",
        employmentType: isTemporaryPartTime ? "temporary_part_time" : "casual",
      },
    });

    staffMembershipIds.push(membership.id);

    // Set weekly availability (varied per staff)
    const schedules: { dayOfWeek: number; startTime: string; endTime: string; isAvailable: boolean }[] = [];

    if (staff.name === "Alex Rivera") {
      for (let d = 1; d <= 5; d++) schedules.push({ dayOfWeek: d, startTime: "06:00", endTime: "14:00", isAvailable: true });
    } else if (staff.name === "Jamie Park") {
      for (let d = 1; d <= 6; d++) schedules.push({ dayOfWeek: d, startTime: "14:00", endTime: "22:00", isAvailable: true });
    } else if (staff.name === "Taylor Smith") {
      for (let d = 1; d <= 5; d++) schedules.push({ dayOfWeek: d, startTime: "08:00", endTime: "18:00", isAvailable: true });
    } else if (staff.name === "Jordan Lee") {
      for (let d = 0; d <= 0; d++) schedules.push({ dayOfWeek: d, startTime: "10:00", endTime: "18:00", isAvailable: true });
      for (let d = 3; d <= 6; d++) schedules.push({ dayOfWeek: d, startTime: "10:00", endTime: "18:00", isAvailable: true });
    } else if (staff.name === "Casey Brown") {
      for (let d = 0; d <= 6; d++) schedules.push({ dayOfWeek: d, startTime: "07:00", endTime: "23:00", isAvailable: true });
    }

    for (const sched of schedules) {
      await tx.availability.upsert({
        where: {
          membershipId_dayOfWeek: { membershipId: membership.id, dayOfWeek: sched.dayOfWeek },
        },
        update: sched,
        create: { ...sched, membershipId: membership.id },
      });
    }
  }

  console.log("Created 5 staff with availability schedules");

  // ============================================================
  // Assign staff to departments
  // ============================================================
  const staffDeptAssignments = [
    { staffIndex: 0, dept: "Kitchen" },         // Alex → Kitchen
    { staffIndex: 1, dept: "Kitchen" },         // Jamie → Kitchen
    { staffIndex: 2, dept: "Kitchen" },         // Taylor → Kitchen
    { staffIndex: 3, dept: "Bar" },             // Jordan → Bar
    { staffIndex: 4, dept: "Front of House" },  // Casey → Front of House
  ];

  for (const assignment of staffDeptAssignments) {
    const dept = departments.find((d) => d.name === assignment.dept);
    if (dept) {
      const existing = await tx.departmentMembership.findUnique({
        where: {
          membershipId_departmentId: {
            membershipId: staffMembershipIds[assignment.staffIndex],
            departmentId: dept.id,
          },
        },
      });
      if (!existing) {
        await tx.departmentMembership.create({
          data: {
            membershipId: staffMembershipIds[assignment.staffIndex],
            departmentId: dept.id,
          },
        });
      }
    }
  }

  console.log("Assigned staff to departments");

  // ============================================================
  // Extra demo staff (for live demo login)
  // ============================================================
  const extraStaff = [
    { name: "Sam Wilson", email: "sam@oceangrill.com", dept: "Bar" },
    { name: "Riley Chen", email: "riley@oceangrill.com", dept: "Front of House" },
    { name: "Morgan Taylor", email: "morgan@oceangrill.com", dept: "Kitchen" },
  ];

  for (const staff of extraStaff) {
    const user = await tx.user.upsert({
      where: { email: staff.email },
      update: { name: staff.name, hashedPassword, emailVerified: new Date() },
      create: {
        name: staff.name,
        email: staff.email,
        hashedPassword,
        emailVerified: new Date(),
      },
    });

    const membership = await tx.membership.upsert({
      where: {
        userId_organizationId: { userId: user.id, organizationId: orgId },
      },
      update: { role: "staff", status: "active" },
      create: {
        userId: user.id,
        organizationId: orgId,
        role: "staff",
        status: "active",
      },
    });

    const dept = departments.find((d) => d.name === staff.dept);
    if (dept) {
      const existing = await tx.departmentMembership.findUnique({
        where: { membershipId_departmentId: { membershipId: membership.id, departmentId: dept.id } },
      });
      if (!existing) {
        await tx.departmentMembership.create({
          data: { membershipId: membership.id, departmentId: dept.id },
        });
      }
    }
  }

  console.log("Created 3 extra demo staff");

  // ============================================================
  // Certifications
  // ============================================================
  //
  // Deliberately spread across the WHOLE lifecycle, not just the happy end
  // state. Every certification used to be seeded as "verified" with almost no
  // expiry dates, so a fresh database showed eight identical green rows: the
  // review queue was empty, nothing was expiring, and nothing had ever been
  // rejected or revoked. None of the workflow the page exists for was visible.
  //
  // Expiry-relative rows are computed from TODAY rather than hardcoded, so the
  // "Expiring soon" tile is still populated whenever this is next run instead of
  // quietly ageing into "Expired".
  //
  // Note the pending row with a lapsed expiry (Alex's Fire Safety Warden): a
  // non-verified certification shows as "Pending", never "Expired", and it gives
  // a reviewer an obvious reason to reach for "Certificate expired".

  const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  /**
   * Midnight today in Singapore, as an instant.
   *
   * The +08:00 offset is written out rather than imported from src/lib/timezone
   * so this script has no dependency on the application's path aliases, matching
   * the reasoning in tests/helpers/time.ts. Singapore has no DST, so a fixed
   * offset is exact.
   */
  const sgtMidnightToday = new Date(
    Math.floor((Date.now() + SGT_OFFSET_MS) / DAY_MS) * DAY_MS - SGT_OFFSET_MS
  );

  /** Singapore midnight, `days` from today. Negative for the past. */
  const daysFromToday = (days: number) =>
    new Date(sgtMidnightToday.getTime() + days * DAY_MS);

  /** An instant `hours` before now — used for realistic "submitted N ago". */
  const hoursAgo = (hours: number) =>
    new Date(Date.now() - hours * 60 * 60 * 1000);

  /**
   * When a review happened, at 10:00 organisation time.
   *
   * Previously every reviewed certification was stamped `new Date()`, so the
   * whole list read "Reviewed by … <the day you seeded>" — including a
   * certificate issued in 2024, reviewed two years later. That reads as
   * placeholder data on a demo screen.
   *
   * Rejections and revocations pass an explicit `daysAgo`, since those are
   * recent decisions. Everything else is reviewed a couple of days after issue,
   * which is what happens in practice, clamped so a certificate issued today is
   * never reviewed in the future.
   */
  const reviewedAt = (issued: Date, daysAgo?: number) => {
    const TEN_AM = 10 * 60 * 60 * 1000;
    if (daysAgo !== undefined) {
      return new Date(daysFromToday(-daysAgo).getTime() + TEN_AM);
    }
    return new Date(
      Math.min(issued.getTime() + 2 * DAY_MS + TEN_AM, Date.now())
    );
  };

  const sarahId = managerUserIds["Sarah Chen"] ?? adminUser.id;
  const marcusId = managerUserIds["Marcus Johnson"] ?? adminUser.id;

  // Placeholder document links. They exist so the "View submitted document"
  // action is visible on the pending rows a reviewer clicks through; swap in a
  // real file if you want the link followed on camera.
  const DOC = "https://example.com/certificates/sample.pdf";

  interface SeedCert {
    staffIndex: number;
    name: string;
    /** Issued date. Number = days from today, string = fixed calendar date. */
    issued: number | string;
    /** Expiry. Omit for "never expires". */
    expiry?: number | string;
    status: "pending" | "verified" | "rejected" | "revoked";
    /** Who reviewed it. Omit for pending. */
    reviewedBy?: string;
    rejectionReason?: string;
    rejectionNotes?: string;
    documentUrl?: string;
    /** When it was submitted, in hours before now. Drives "submitted N ago". */
    submittedHoursAgo?: number;
    /**
     * Days before today that the review happened. Omit to have it fall a couple
     * of days after the issue date, which suits certificates that were simply
     * checked and accepted.
     */
    reviewedDaysAgo?: number;
  }

  const certData: SeedCert[] = [
    // ---- Verified, valid indefinitely (the existing baseline) ----
    { staffIndex: 0, name: "Food Safety Level 2", issued: "2026-01-15", status: "verified", reviewedBy: adminUser.id },
    { staffIndex: 0, name: "First Aid", issued: "2025-06-01", status: "verified", reviewedBy: adminUser.id },
    { staffIndex: 1, name: "Food Safety Level 2", issued: "2026-03-01", status: "verified", reviewedBy: adminUser.id },
    { staffIndex: 2, name: "Food Safety Level 2", issued: "2025-11-01", status: "verified", reviewedBy: adminUser.id },
    { staffIndex: 2, name: "First Aid", issued: "2026-02-01", status: "verified", reviewedBy: adminUser.id },
    { staffIndex: 2, name: "RSA Certification", issued: "2026-01-01", expiry: "2027-01-01", status: "verified", reviewedBy: adminUser.id },
    { staffIndex: 4, name: "Food Safety Level 2", issued: "2026-04-01", status: "verified", reviewedBy: adminUser.id },
    { staffIndex: 4, name: "Barista Certificate", issued: "2026-03-15", status: "verified", reviewedBy: sarahId },

    // ---- Awaiting review — populates the queue the page is built around ----
    {
      staffIndex: 1,
      name: "Bar Service Certification",
      issued: -40,
      expiry: 1055,
      status: "pending",
      documentUrl: DOC,
      submittedHoursAgo: 48,
    },
    {
      staffIndex: 4,
      name: "Allergen Awareness",
      issued: -10,
      status: "pending",
      documentUrl: DOC,
      submittedHoursAgo: 6,
    },
    {
      // Submitted already lapsed. Shows as "Pending", not "Expired".
      staffIndex: 0,
      name: "Fire Safety Warden",
      issued: -1500,
      expiry: -60,
      status: "pending",
      documentUrl: DOC,
      submittedHoursAgo: 120,
    },

    // ---- Verified but expiring inside the 30-day warning window ----
    {
      staffIndex: 2,
      name: "Food Hygiene Supervisor",
      issued: -700,
      expiry: 12,
      status: "verified",
      reviewedBy: sarahId,
    },
    {
      staffIndex: 1,
      name: "First Aid",
      issued: -1080,
      expiry: 26,
      status: "verified",
      reviewedBy: adminUser.id,
    },

    // ---- Verified but lapsed: kept on record, no longer counts ----
    {
      staffIndex: 4,
      name: "Manual Handling",
      issued: -800,
      expiry: -45,
      status: "verified",
      reviewedBy: marcusId,
    },

    // ---- Refused outright: never counted ----
    {
      staffIndex: 0,
      name: "Barista Certificate",
      issued: -300,
      status: "rejected",
      reviewedBy: sarahId,
      rejectionReason: "document_unreadable",
      rejectionNotes:
        "The photo is too blurry to read the issue date. Please upload a clearer scan.",
      documentUrl: DOC,
      reviewedDaysAgo: 9,
    },

    // ---- Honoured, then withdrawn: the audit trail survives ----
    {
      staffIndex: 2,
      name: "Wine & Spirits Certification",
      issued: -450,
      expiry: 400,
      status: "revoked",
      reviewedBy: adminUser.id,
      rejectionReason: "details_mismatch",
      rejectionNotes:
        "The name on the certificate does not match your employee record. Please resubmit one issued in your registered name.",
      reviewedDaysAgo: 21,
    },
  ];

  const toDate = (value: number | string) =>
    typeof value === "number" ? daysFromToday(value) : new Date(value);

  for (const cert of certData) {
    const issuedDate = toDate(cert.issued);

    const data = {
      membershipId: staffMembershipIds[cert.staffIndex],
      name: cert.name,
      issuedDate,
      expiryDate: cert.expiry === undefined ? null : toDate(cert.expiry),
      status: cert.status,
      documentUrl: cert.documentUrl ?? null,
      // Prisma treats `undefined` as "leave alone", so these are written as
      // explicit nulls — otherwise a row edited during a demo would keep a
      // stale rejection reason after the seed reset it to pending.
      rejectionReason: cert.rejectionReason ?? null,
      rejectionNotes: cert.rejectionNotes ?? null,
      verifiedById: cert.status === "pending" ? null : cert.reviewedBy ?? adminUser.id,
      verifiedAt:
        cert.status === "pending"
          ? null
          : reviewedAt(issuedDate, cert.reviewedDaysAgo),
      ...(cert.submittedHoursAgo !== undefined
        ? { createdAt: hoursAgo(cert.submittedHoursAgo) }
        : {}),
    };

    const existing = await tx.certification.findFirst({
      where: { membershipId: data.membershipId, name: cert.name },
    });

    if (existing) {
      // Updated rather than skipped, unlike before. The expiry-relative rows are
      // computed from today, so a re-run has to refresh them — leaving them in
      // place is how "expires in 12 days" silently becomes "expired" a fortnight
      // later. It also resets anything verified or rejected by hand mid-demo.
      await tx.certification.update({ where: { id: existing.id }, data });
    } else {
      await tx.certification.create({ data });
    }
  }

  console.log(
    `Created ${certData.length} certifications across the full lifecycle ` +
      "(pending, verified, expiring, expired, rejected, revoked)"
  );

  // ============================================================
  // Clean old demo tasks for fresh data
  // ============================================================
  console.log("Cleaning old task data for fresh charts...");
  await tx.task.deleteMany({ where: { organizationId: orgId } });
  await tx.auditLog.deleteMany({ where: { organizationId: orgId } });
  console.log("Cleaned old tasks and audit logs");

  // ============================================================
  // Upcoming tasks (tomorrow)
  // ============================================================
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  // Typed explicitly: only one entry carries requiredCertifications, and
  // relying on TypeScript to normalise a heterogeneous array literal into a
  // shape with the missing property optional is exactly the kind of inference
  // that differs between compiler versions.
  interface SeedTask {
    title: string;
    description: string;
    departmentId: string;
    priority: string;
    requiredHeadcount: number;
    startHour: number;
    endHour: number;
    requiredCertifications?: string[];
  }

  const taskData: SeedTask[] = [
    {
      title: "Morning Kitchen Prep",
      description: "Prepare mise en place, check deliveries, prep sauces",
      departmentId: departments[0].id,
      priority: "high",
      requiredHeadcount: 2,
      startHour: 7,
      endHour: 10,
      // No seeded task required a certification, so the reason certifications
      // exist — gating who may be assigned — was invisible in a demo. Food
      // Safety Level 2 is held and verified by every kitchen staff member, so
      // the requirement shows up on the task and in the eligibility check
      // without making anyone ineligible.
      requiredCertifications: ["Food Safety Level 2"],
    },
    {
      title: "Lunch Service",
      description: "Full lunch service including cooking and plating",
      departmentId: departments[0].id,
      priority: "urgent",
      requiredHeadcount: 3,
      startHour: 11,
      endHour: 15,
    },
    {
      title: "Bar Setup & Inventory",
      description: "Stock bar, prepare garnishes, check inventory levels",
      departmentId: departments[1].id,
      priority: "medium",
      requiredHeadcount: 1,
      startHour: 10,
      endHour: 12,
    },
    {
      title: "Evening Dining Service",
      description: "Full dinner service, table management, guest relations",
      departmentId: departments[2].id,
      priority: "high",
      requiredHeadcount: 2,
      startHour: 17,
      endHour: 22,
    },
    {
      title: "Deep Clean Kitchen",
      description: "Weekly deep clean of all kitchen surfaces and equipment",
      departmentId: departments[0].id,
      priority: "medium",
      requiredHeadcount: 2,
      startHour: 15,
      endHour: 17,
    },
  ];

  for (const t of taskData) {
    const start = new Date(tomorrow);
    start.setHours(t.startHour);
    const end = new Date(tomorrow);
    end.setHours(t.endHour);

    await tx.task.create({
      data: {
        title: t.title,
        description: t.description,
        organizationId: orgId,
        departmentId: t.departmentId,
        priority: t.priority,
        requiredHeadcount: t.requiredHeadcount,
        requiredCertifications: t.requiredCertifications ?? [],
        scheduledStart: start,
        scheduledEnd: end,
        createdById: adminUser.id,
      },
    });
  }

  console.log("Created 5 tasks for tomorrow");

  // ============================================================
  // Company settings
  // ============================================================
  const existingSettings = await tx.companySettings.findUnique({
    where: { organizationId: orgId },
  });
  if (!existingSettings) {
    await tx.companySettings.create({
      data: {
        organizationId: orgId,
        allocationMode: "auto",
        breakRuleHoursWorked: 8,
        breakRuleBreakHours: 1,
      },
    });
  }

  // ============================================================
  // Work Rules (demo rules for Ocean Grill)
  // ============================================================
  const workRules = [
    {
      name: "Kitchen daily limit",
      type: "max_hours_daily",
      departmentId: departments[0].id,
      maxHours: 10,
    },
    {
      name: "Service break interval",
      type: "break_interval",
      departmentId: null,
      hoursThreshold: 6,
      breakHours: 1,
    },
    {
      name: "Weekly hour cap",
      type: "max_hours_weekly",
      departmentId: null,
      maxHours: 48,
    },
  ];

  for (const rule of workRules) {
    const existing = await tx.workRule.findUnique({
      where: { organizationId_name: { organizationId: orgId, name: rule.name } },
    });
    if (!existing) {
      await tx.workRule.create({
        data: {
          organizationId: orgId,
          name: rule.name,
          type: rule.type,
          departmentId: rule.departmentId,
          hoursThreshold: rule.hoursThreshold ?? null,
          breakHours: rule.breakHours ?? null,
          maxHours: rule.maxHours ?? null,
        },
      });
    }
  }

  console.log("Created 3 work rules");

  // ============================================================
  // Historical completed tasks (for reporting charts)
  // ============================================================
  console.log("Creating historical task data for charts...");

  const now = new Date();

  for (let daysAgo = 1; daysAgo <= 7; daysAgo++) {
    const taskDate = new Date(now);
    taskDate.setDate(taskDate.getDate() - daysAgo);
    taskDate.setHours(0, 0, 0, 0);

    const dayOfWeek = taskDate.getDay();
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    const taskCount = isWeekday ? 2 + (daysAgo % 2) : 1;

    for (let t = 0; t < taskCount; t++) {
      const startHour = 7 + t * 3;
      const endHour = startHour + 2 + (t % 2);
      const deptIndex = t % departments.length;

      const startTime = new Date(taskDate);
      startTime.setHours(startHour);
      const endTime = new Date(taskDate);
      endTime.setHours(endHour);

      const dateLabel = taskDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const taskTitle = `${departments[deptIndex].name} - ${dateLabel} #${t + 1}`;

      const task = await tx.task.create({
        data: {
          title: taskTitle,
          description: "Historical task for reporting data",
          organizationId: orgId,
          departmentId: departments[deptIndex].id,
          priority: t === 0 ? "high" : "medium",
          requiredHeadcount: 1 + (t % 2),
          scheduledStart: startTime,
          scheduledEnd: endTime,
          status: "completed",
          createdById: adminUser.id,
        },
      });

      const assignCount = Math.min(task.requiredHeadcount, staffMembershipIds.length);
      for (let a = 0; a < assignCount; a++) {
        const staffIndex = (daysAgo + t + a) % staffMembershipIds.length;
        const membershipId = staffMembershipIds[staffIndex];

        const clockIn = new Date(startTime);
        clockIn.setMinutes(clockIn.getMinutes() + 5 + a * 2);
        const clockOut = new Date(endTime);
        clockOut.setMinutes(clockOut.getMinutes() - 10 + a * 3);

        await tx.taskAssignment.create({
          data: {
            taskId: task.id,
            membershipId,
            assignedById: adminUser.id,
            status: "completed",
            clockInTime: clockIn,
            clockOutTime: clockOut,
          },
        });
      }
    }
  }

  console.log("Created historical tasks with clock data");

  // ============================================================
  // Unaffiliated user (for onboarding demo)
  // ============================================================
  await tx.user.upsert({
    where: { email: "new@smarttask.com" },
    update: {
      name: "New User",
      hashedPassword,
      emailVerified: new Date(),
    },
    create: {
      name: "New User",
      email: "new@smarttask.com",
      hashedPassword,
      emailVerified: new Date(),
    },
  });
  console.log("Created unaffiliated user for onboarding demo");

  // ============================================================
  // Platform Admin
  // ============================================================
  await tx.user.upsert({
    where: { email: "platform@smarttask.com" },
    update: {
      name: "Platform Admin",
      hashedPassword,
      emailVerified: new Date(),
      isPlatformAdmin: true,
    },
    create: {
      name: "Platform Admin",
      email: "platform@smarttask.com",
      hashedPassword,
      emailVerified: new Date(),
      isPlatformAdmin: true,
    },
  });
  console.log("Platform admin ready");

  // ============================================================
  // Summary
  // ============================================================
  console.log("\nDemo data seeded successfully!");
  console.log("\nLogin credentials (all accounts):");
  console.log("Password: TestPass1!");
  console.log("\nAccounts:");
  console.log("  Platform: platform@smarttask.com (Platform Admin)");
  console.log("  Admin:    admin@oceangrill.com");
  console.log("  Manager:  sarah@oceangrill.com (Kitchen)");
  console.log("  Manager:  marcus@oceangrill.com (Bar)");
  console.log("  Staff:    alex@oceangrill.com (Kitchen, Temporary/Part-Time, Morning Mon-Fri)");
  console.log("  Staff:    jamie@oceangrill.com (Kitchen, Temporary/Part-Time, Evening Mon-Sat)");
  console.log("  Staff:    taylor@oceangrill.com (Kitchen, Temporary/Part-Time, Full day Mon-Fri)");
  console.log("  Staff:    jordan@oceangrill.com (Bar, Casual, Part time Wed-Sun)");
  console.log("  Staff:    casey@oceangrill.com (Front of House, Casual, Flexible all week)");
  console.log("  Staff:    sam@oceangrill.com (Bar, Casual)");
  console.log("  Staff:    riley@oceangrill.com (Front of House, Casual)");
  console.log("  Staff:    morgan@oceangrill.com (Kitchen, Casual)");
  console.log("  New user: new@smarttask.com (No org — lands on onboarding)");
}

// Run everything inside a single interactive transaction.
// This keeps PgBouncer on one backend connection, avoiding
// "prepared statement already exists" errors.
prisma
  .$transaction(seedAll, { maxWait: 30000, timeout: 120000 })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
