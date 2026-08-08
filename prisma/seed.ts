/**
 * Database Seed Script
 *
 * Seeds the Permission table with all predefined permissions
 * organized by category, and industry templates.
 *
 * All queries run inside a single interactive $transaction so that
 * PgBouncer (Supabase) keeps one backend connection throughout,
 * avoiding "prepared statement already exists" errors.
 *
 * Run with: npx prisma db seed
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { PERMISSIONS } from "../src/lib/permissions";

const prisma = new PrismaClient();

type Tx = Prisma.TransactionClient;

/*
 * The catalogue lives in `src/lib/permissions.ts`, not here.
 *
 * It used to be defined in this file and nowhere else, which is how it came to
 * be seeded, displayed and never once read back by application code. Now the
 * guard, the role bundles and this seed all take the same list, so a permission
 * cannot exist in the database without something able to enforce it.
 */
const permissions = PERMISSIONS;

// ============================================================
// Industry Templates
// ============================================================

const industryTemplates = [
  {
    name: "Hospitality / F&B",
    icon: "UtensilsCrossed",
    description: "Restaurants, cafes, bars, hotels",
    departments: [
      { name: "Kitchen", description: "Food preparation, cooking, and plating operations", color: "#EF4444" },
      { name: "Bar", description: "Beverage service, inventory, and cocktail preparation", color: "#3B82F6" },
      { name: "Front of House", description: "Guest relations, table management, dining room", color: "#10B981" },
    ],
    workRules: [
      { name: "Service break interval", type: "break_interval", hoursThreshold: 6, breakHours: 1, reason: "Long service periods require regular rest to maintain quality" },
      { name: "Daily shift cap", type: "max_hours_daily", maxHours: 10, reason: "Prevents fatigue during double shifts in fast-paced kitchens" },
    ],
    certifications: ["Food Safety Level 2", "RSA Certification", "First Aid"],
  },
  {
    name: "Healthcare",
    icon: "HeartPulse",
    description: "Hospitals, clinics, care facilities",
    departments: [
      { name: "Emergency", description: "Acute care, triage, and emergency response", color: "#EF4444" },
      { name: "General Ward", description: "Inpatient care, monitoring, and recovery", color: "#3B82F6" },
      { name: "Outpatient", description: "Scheduled consultations, procedures, and follow-ups", color: "#10B981" },
    ],
    workRules: [
      { name: "Shift duration cap", type: "max_hours_daily", maxHours: 12, reason: "Patient safety requires alert, rested staff on every shift" },
      { name: "Weekly rotation limit", type: "max_hours_weekly", maxHours: 48, reason: "Mandatory rest between rotations to prevent clinical errors" },
    ],
    certifications: ["Nursing License", "CPR Certification", "First Aid"],
  },
  {
    name: "Retail",
    icon: "ShoppingCart",
    description: "Stores, malls, supermarkets",
    departments: [
      { name: "Sales Floor", description: "Customer assistance, product display, and merchandising", color: "#8B5CF6" },
      { name: "Warehouse", description: "Stock management, receiving, and inventory control", color: "#F59E0B" },
      { name: "Customer Service", description: "Returns, inquiries, complaints, and support", color: "#10B981" },
    ],
    workRules: [
      { name: "Floor break interval", type: "break_interval", hoursThreshold: 6, breakHours: 1, reason: "Retail staff on their feet for extended periods need regular breaks" },
      { name: "Casual weekly limit", type: "max_hours_weekly", maxHours: 38, reason: "Standard casual employment cap under retail awards" },
    ],
    certifications: ["First Aid", "Cash Handling Certification"],
  },
  {
    name: "Construction",
    icon: "HardHat",
    description: "Building, infrastructure, trades",
    departments: [
      { name: "Electrical", description: "Electrical systems installation, wiring, and maintenance", color: "#F59E0B" },
      { name: "Structural", description: "Foundation, framing, and load-bearing construction", color: "#6B7280" },
      { name: "Plumbing", description: "Water systems, drainage, and pipe fitting", color: "#3B82F6" },
    ],
    workRules: [
      { name: "Physical labor daily cap", type: "max_hours_daily", maxHours: 10, reason: "Physical fatigue increases injury risk on construction sites" },
      { name: "Mandatory site break", type: "break_interval", hoursThreshold: 6, breakHours: 1, reason: "Safety-critical rest requirement for heavy machinery operators" },
    ],
    certifications: ["Safety Induction (White Card)", "Working at Heights", "First Aid"],
  },
  {
    name: "Software / IT Ops",
    icon: "Server",
    description: "Support desks, on-call rotations, DevOps",
    departments: [
      { name: "Helpdesk", description: "Tier 1-3 technical support and ticket resolution", color: "#3B82F6" },
      { name: "DevOps", description: "Infrastructure, deployments, and system monitoring", color: "#10B981" },
      { name: "QA", description: "Testing windows, release validation, and bug triage", color: "#8B5CF6" },
      { name: "Infrastructure", description: "Server maintenance, network operations, and patching", color: "#F59E0B" },
    ],
    workRules: [
      { name: "Operations weekly cap", type: "max_hours_weekly", maxHours: 40, reason: "Standard workweek for IT operations to prevent burnout" },
      { name: "On-call shift cap", type: "max_hours_daily", maxHours: 12, reason: "Sustained alertness required for incident response" },
    ],
    certifications: ["AWS Certified", "ITIL Foundation", "Security Clearance"],
  },
];

async function seedAll(tx: Tx) {
  console.log("Seeding permissions...");

  for (const perm of permissions) {
    await tx.permission.upsert({
      where: { name: perm.name },
      update: { description: perm.description, category: perm.category },
      create: perm,
    });
  }

  /*
   * Remove permissions the catalogue no longer defines.
   *
   * Upserting alone only ever ADDS. Sixteen entries were retired in the audit
   * that left the catalogue at 28, and without this they would sit in the table
   * forever — still listed by `getAllPermissions`, still offered in the Roles
   * picker, and still tickable, while no code path could ever read them. That
   * is precisely the state this whole exercise was undoing.
   *
   * `RolePermission.permissionId` cascades on delete, so any custom role that
   * had one of these ticked loses that entry, silently and irreversibly. That
   * is the correct outcome — the permission granted nothing, so removing it
   * takes nothing away — but it is a destructive write against production
   * data, so both counts are reported below rather than just the permissions'.
   * A role composed ENTIRELY of retired names becomes an empty role. That used
   * to be the dangerous case — an empty role meant "nothing", so its holders
   * were left with no permissions at all rather than falling back to their
   * system bundle. Custom roles add rather than replace now, so an emptied role
   * is merely inert and its holders keep everything their system role gives
   * them. The count is still printed: a role that silently stopped granting
   * what somebody composed it for is worth knowing about either way.
   */
  const doomed = await tx.permission.findMany({
    where: { name: { notIn: permissions.map((p) => p.name) } },
    select: { name: true, _count: { select: { rolePermissions: true } } },
  });
  const grantsLost = doomed.reduce((n, p) => n + p._count.rolePermissions, 0);

  const retired = await tx.permission.deleteMany({
    where: { name: { notIn: permissions.map((p) => p.name) } },
  });

  console.log(
    `Seeded ${permissions.length} permissions` +
      (retired.count > 0
        ? `, removed ${retired.count} retired (${doomed
            .map((p) => p.name)
            .join(", ")})` +
          (grantsLost > 0
            ? `, dropping ${grantsLost} custom-role grant(s).`
            : ".")
        : ".")
  );

  console.log("Seeding industry templates...");

  for (const template of industryTemplates) {
    await tx.industryTemplate.upsert({
      where: { name: template.name },
      update: {
        icon: template.icon,
        description: template.description,
        departments: template.departments,
        workRules: template.workRules,
        certifications: template.certifications,
      },
      create: {
        name: template.name,
        icon: template.icon,
        description: template.description,
        departments: template.departments,
        workRules: template.workRules,
        certifications: template.certifications,
        isActive: true,
        isAiGenerated: false,
      },
    });
  }

  console.log(`Seeded ${industryTemplates.length} industry templates.`);
}

// Run everything inside a single interactive transaction.
// This keeps PgBouncer on one backend connection, avoiding
// "prepared statement already exists" errors.
//
// The timeouts are generous because they are not measuring the work. Seeding is
// ~35 upserts and takes well under a second on a reachable database; what these
// have to survive is everything AROUND the work — a laptop that sleeps mid-run,
// a slow link to Supabase, or a connection stalling on an unreachable host. A
// two-minute ceiling turned any of those into "Transaction already closed",
// which reads like the seed was too big when nothing had run at all.
prisma
  .$transaction(seedAll, { maxWait: 120000, timeout: 900000 })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
