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

const prisma = new PrismaClient();

type Tx = Prisma.TransactionClient;

const permissions = [
  // Department management
  { name: "departments:create", description: "Create new departments", category: "departments" },
  { name: "departments:read", description: "View departments", category: "departments" },
  { name: "departments:update", description: "Update department details", category: "departments" },
  { name: "departments:delete", description: "Delete departments", category: "departments" },

  // Member management
  { name: "members:read", description: "View organization members", category: "members" },
  { name: "members:invite", description: "Invite new members", category: "members" },
  { name: "members:update_role", description: "Update member roles", category: "members" },
  { name: "members:deactivate", description: "Activate or deactivate members", category: "members" },

  // Task management (Phase 4)
  { name: "tasks:create", description: "Create new tasks", category: "tasks" },
  { name: "tasks:read", description: "View tasks", category: "tasks" },
  { name: "tasks:update", description: "Update task details", category: "tasks" },
  { name: "tasks:delete", description: "Delete tasks", category: "tasks" },
  { name: "tasks:assign", description: "Assign staff to tasks", category: "tasks" },
  { name: "tasks:accept_reject", description: "Accept or reject task assignments", category: "tasks" },
  { name: "tasks:clock", description: "Clock in and out of tasks", category: "tasks" },

  // Eligibility & allocation (Phase 5)
  { name: "eligibility:view", description: "View eligibility status of staff", category: "eligibility" },
  { name: "eligibility:override", description: "Override eligibility blocks with reason", category: "eligibility" },
  { name: "allocation:use_suggestions", description: "Use AI-powered allocation suggestions", category: "allocation" },
  { name: "allocation:auto_allocate", description: "Trigger auto-allocation for tasks", category: "allocation" },

  // Reporting (Phase 6)
  { name: "reports:view", description: "View reports and analytics", category: "reports" },
  { name: "reports:export", description: "Export reports as CSV or PDF", category: "reports" },

  // Calendar (Phase 6)
  { name: "calendar:view", description: "View calendar", category: "calendar" },
  { name: "calendar:manage_availability", description: "Manage own availability schedule", category: "calendar" },

  // Notifications (Phase 6)
  { name: "notifications:receive", description: "Receive notifications", category: "notifications" },
  { name: "notifications:manage", description: "Manage notification preferences", category: "notifications" },

  // Settings (Phase 3)
  { name: "settings:read", description: "View company settings", category: "settings" },
  { name: "settings:update", description: "Update company settings", category: "settings" },

  // Roles (Phase 3)
  { name: "roles:create", description: "Create custom roles", category: "roles" },
  { name: "roles:read", description: "View roles and permissions", category: "roles" },
  { name: "roles:update", description: "Update role permissions", category: "roles" },
  { name: "roles:delete", description: "Delete custom roles", category: "roles" },

  // Organization (Phase 2)
  { name: "organization:read", description: "View organization details", category: "organization" },
  { name: "organization:update", description: "Update organization profile", category: "organization" },

  // Audit (Phase 7)
  { name: "audit:view", description: "View audit logs", category: "audit" },
];

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

  console.log(`Seeded ${permissions.length} permissions.`);

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
prisma
  .$transaction(seedAll, { maxWait: 30000, timeout: 120000 })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
