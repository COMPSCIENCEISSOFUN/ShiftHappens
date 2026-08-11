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
 * - 5 upcoming tasks (tomorrow), two carrying composition rules
 * - 90 days of historical completed tasks, department-scoped
 * - Completed assignments with clock in/out data
 * - A deliberate seniority spread — each department has a senior, an
 *   experienced and a junior member, so composition rules can be shown
 *   refusing and permitting rather than described
 * - Satisfaction ratings correlated with the engine's rank, so the
 *   "did the top pick enjoy it more?" comparison has something to say
 * - Response timestamps, including rows deliberately left unanswered so the
 *   "no reply recorded" bucket is visible rather than theoretical
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

/**
 * Deterministic allocation provenance for a seeded assignment.
 *
 * Keyed off an integer derived from the loop counters rather than random, so
 * `npx tsx prisma/seed-demo.ts` twice produces byte-identical data. A demo you
 * cannot reproduce is a demo you cannot screenshot.
 *
 * The distribution is chosen to make the Engine Insights page readable rather
 * than flattering:
 *   - ~40% manual, because most real assignments still are
 *   - ~35% AI-suggested, with rank and score, mostly rank 1 but not always
 *   - ~15% auto-scheduled from a confirmed week draft
 *   - ~10% left entirely unrecorded, so the "we do not know" case is on screen
 *
 * Providers are split across groq and gemini with a slice on the algorithmic
 * fallback — that last one matters, because seeing the fallback in the chart is
 * the point of recording the provider at all.
 */
function allocationProvenanceFor(seed: number): {
  allocationSource?: string;
  allocationProvider?: string;
  allocationRank?: number;
  allocationScore?: number;
} {
  const bucket = seed % 20;

  if (bucket < 2) return {}; // unrecorded

  if (bucket < 10) return { allocationSource: "manual" };

  if (bucket < 17) {
    const rank = (seed % 3) + 1;
    return {
      allocationSource: "ai_suggested",
      allocationProvider: bucket % 3 === 0 ? "gemini" : "groq",
      allocationRank: rank,
      allocationScore: 92 - rank * 9 - (seed % 5),
    };
  }

  return {
    allocationSource: "auto_scheduled",
    allocationProvider: bucket === 19 ? "algorithmic" : "groq",
    allocationRank: (seed % 2) + 1,
    allocationScore: 80 - (seed % 7),
  };
}


/**
 * How far back the shift history runs.
 *
 * Long enough that a member working every other day clears the 40-shift senior
 * threshold in every department, not just the one that opens on Sundays. At 90
 * days the bar and front-of-house leads landed on 37 — under the line, so two
 * of the three departments had no senior at all and the rules referring to one
 * could not be shown working.
 *
 * A week of history, which is what this seed used to create, leaves every
 * member on zero and every panel on its empty state.
 */
const HISTORY_DAYS = 105;

/**
 * How often each staff member works, in days.
 *
 * This is the whole point of the history: it manufactures a seniority spread.
 * Every department ends up with someone well past the senior threshold,
 * someone comfortably experienced, and someone still junior — which is exactly
 * the roster a rule like "at most 1 junior on this shift" needs in order to
 * refuse one assignment and permit the next.
 *
 * Keyed by email because membership ids are generated and differ per database,
 * while these addresses are fixed by this file.
 */
const SHIFT_CADENCE: Record<string, number> = {
  // Managers work the floor too. Without history they read "Junior — 0
  // completed shifts", which is both odd on screen and wrong for the rules:
  // a manager is not the junior a composition constraint is guarding against.
  "sarah@oceangrill.com": 4,
  "marcus@oceangrill.com": 4,
  // Kitchen — Alex and Jamie carry the department, Taylor is solid, Morgan is new.
  "alex@oceangrill.com": 2,
  "jamie@oceangrill.com": 2,
  "taylor@oceangrill.com": 5,
  "morgan@oceangrill.com": 14,
  // Bar
  "jordan@oceangrill.com": 2,
  "sam@oceangrill.com": 13,
  // Front of House
  "casey@oceangrill.com": 2,
  "riley@oceangrill.com": 15,
};

/** Anyone not named above still appears occasionally rather than never. */
const DEFAULT_CADENCE = 9;

/**
 * A staff member's own rating of a worked shift, or null for "not rated".
 *
 * Deliberately correlated with the engine's rank: shifts where the engine's
 * top pick took the job score higher than shifts filled further down the list.
 * That correlation is the demo — it is what makes the satisfaction panel's
 * rank-1-versus-the-rest comparison show a gap instead of two identical
 * numbers. It is seeded data making a plausible claim, not evidence, and the
 * panel says as much on screen.
 *
 * Around 40% are left unrated, because in practice most people do not fill in
 * an optional box, and a 100% response rate would be the least believable
 * number on the page.
 */
function ratingFor(seed: number, rank: number | undefined): number | null {
  if (seed % 5 >= 3) return null;

  if (rank === 1) return seed % 4 === 0 ? 4 : 5;

  if (rank !== undefined) {
    // A visible gap below the top pick, but not a chasm. An earlier version
    // put lower-ranked picks on 2s and 3s, which produced 4.8 against 2.9 on
    // the panel — a difference so large it reads as invented rather than
    // observed, and invites exactly the question the panel is meant to
    // survive. One 1 and a scattering of 2s keep the low-rating notification
    // path visible without claiming the engine is transformative.
    if (seed % 23 === 0) return 1;
    if (seed % 7 === 0) return 2;
    return seed % 3 === 0 ? 3 : 4;
  }

  return seed % 7 === 0 ? 3 : 4;
}

/**
 * Free text staff leave on a shift, pooled by rating.
 *
 * Several phrasings per rating, not one, and the pools overlap on three
 * subjects on purpose: nobody handing over at the start, the evening pass
 * running short once it fills, and deliveries landing mid-service.
 *
 * This is what the feedback-themes panel reads. A single canned line per rating
 * would let it report a "theme" that is really one sentence repeated verbatim —
 * the panel would look like it worked while demonstrating nothing, because
 * grouping identical strings needs no model at all. Different words about the
 * same problem is the case worth showing.
 */
const RATING_COMMENTS: Record<number, string[]> = {
  1: [
    "Nobody briefed me and I was on my own for the first hour.",
    "Turned up and no one knew I was rostered — waited around for ages.",
    "No handover at all, had to work out the section myself.",
  ],
  2: [
    "Short-staffed after eight, could have used one more on the pass.",
    "Evening got away from us once it filled up, not enough hands.",
    "Ran the pass on my own for most of the second half.",
  ],
  3: [
    "Fine, but the delivery arrived mid-service again.",
    "Went alright. Stock drop landed right in the middle of the rush.",
    "No complaints, though the delivery timing is still awkward.",
    "Busy but manageable, though we were light on the pass after eight.",
  ],
  /*
   * Deliberately the largest pool. `ratingFor` makes 4 by far the most common
   * rating, so with two phrasings roughly a quarter of every comment in the
   * database was one identical sentence — the model would have found a
   * "theme" that was a single string repeated, which is the failure the pools
   * were introduced to prevent. Pool size follows how often the rating occurs.
   */
  4: [
    "Steady enough, nothing to report.",
    "Good shift, but I picked up the section with no handover again.",
    "Fine overall. Delivery came in while we were plating, as usual.",
    "Went well, though we were a hand short on the pass after eight.",
    "No issues worth writing up.",
    "Solid shift — bit of a scramble when the stock drop landed.",
  ],
  5: [
    "Good shift — everyone knew what they were doing.",
    "Smooth all the way through, and the handover was clear for once.",
    "Best one in a while. Proper brief at the start made the difference.",
    "Well run from open to close, no complaints at all.",
  ],
};

/**
 * Deterministic pick from a rating's pool.
 *
 * ## Why it is not `seed % pool.length`
 *
 * The caller only writes a comment when the rating is low or `seed % 3 === 0`,
 * so a plain modulus on a three-entry pool always returns index 0 — the first
 * version of this seeded 17 comments drawn from four distinct sentences, which
 * is exactly the "grouping identical strings" case the pools exist to avoid.
 *
 * `Math.floor(seed / 3) % length` fixed most of it but not all. `ratingFor`
 * and `allocationProvenanceFor` key off the SAME seed, so which rating a shift
 * gets and which index it lands on stayed correlated — and any arithmetic that
 * is a simple function of the seed inherits that. Simulating the full
 * generator over all 105 days x 3 departments x 7 members found pool entries
 * that never appeared at all, and one sentence carrying a quarter of every
 * comment in the database.
 *
 * A mixing hash rather than more division: it destroys the structure the seed
 * carries instead of dividing it out, and folding the rating in means two
 * shifts with the same seed but different ratings no longer share an offset.
 * `Math.imul` because these products overflow 32 bits and plain `*` would lose
 * the low bits doing the work. Still deterministic — the same database every
 * run, which is the point of a seed.
 *
 * Verified by simulation, not by reading: every entry in every pool is
 * reachable, and no single sentence exceeds a tenth of the corpus.
 */
function commentFor(rating: number, seed: number): string | null {
  const pool = RATING_COMMENTS[rating];
  if (!pool || pool.length === 0) return null;
  return pool[mixIndex(rating, seed) % pool.length];
}

/** Deterministic 32-bit mix of a seed and a rating. See `commentFor`. */
function mixIndex(rating: number, seed: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= Math.imul(rating, 3266489917);
  return (h ^ (h >>> 13)) >>> 0;
}

/** Free text alongside a withdrawal, echoing the reason in the member's words. */
const WITHDRAWAL_NOTES: Record<string, string[]> = {
  feeling_unwell: [
    "Came down with something overnight, sorry for the short notice.",
    "Not well enough to be near food today.",
  ],
  transport_issues: [
    "Last bus does not run late enough to get me home from this one.",
    "No way back after the close, the service stops before we finish.",
  ],
};

/** Which reason a withdrawal carries. Seed parity, so both appear. */
function withdrawalReasonFor(seed: number): string {
  return seed % 2 === 0 ? "feeling_unwell" : "transport_issues";
}

/**
 * The note beside that reason.
 *
 * Same trap as `commentFor`: the reason is chosen on seed parity, so indexing
 * the pool by that parity again would pin every row to one entry. Divided
 * first, and taken modulo the pool's own length rather than a hardcoded 2 —
 * with the constant, adding a third phrasing would have made it unreachable
 * and nothing would have said so.
 */
function withdrawalNoteFor(seed: number): string {
  const pool = WITHDRAWAL_NOTES[withdrawalReasonFor(seed)];
  return pool[Math.floor(seed / 2) % pool.length];
}

/**
 * Hours between an assignment being offered and answered, or null for
 * "never answered".
 *
 * The null case matters more than the numbers. An organisation running
 * auto-accept produces rows nobody ever responded to, and the response panel
 * has to hold them apart from fast responses rather than averaging them in as
 * zeroes. Seeding a slice of them is the only way to see that on screen.
 */
function responseLagHoursFor(seed: number): number | null {
  const bucket = seed % 20;
  if (bucket < 3) return null;
  if (bucket < 12) return 0.2 + (bucket % 5) * 0.4;
  if (bucket < 18) return 3 + (bucket % 4) * 2;
  return 26 + (bucket % 3) * 9;
}

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
    /*
     * `subscriptionStatus` and `currentPeriodEnd` so the billing page shows a
     * status and a renewal date rather than two dashes.
     *
     * `stripeCustomerId` is deliberately left null. Setting a fake one would
     * put a "Manage billing" button on screen that fails the moment it is
     * pressed, because Stripe has never heard of it — a demo that breaks when
     * touched is worse than one that says "nothing to manage yet".
     */
    data: {
      subscriptionTier: "pro",
      subscriptionStatus: "active",
      billingInterval: "month",
      currentPeriodEnd: new Date(Date.now() + 18 * 86_400_000),
    },
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
  /*
   * `employmentType` stated, not left to the default.
   *
   * Managers can be rostered, so the field means something for them — and NULL
   * reads as casual everywhere, which had both demo managers presented as
   * casual staff whose availability was their own to set. A demo that leaves a
   * meaningful field unset is a demo that shows the fallback.
   */
  const managers = [
    { name: "Sarah Chen", email: "sarah@oceangrill.com", dept: "Kitchen", employmentType: "full_time" },
    { name: "Marcus Johnson", email: "marcus@oceangrill.com", dept: "Bar", employmentType: "casual" },
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
      update: {
        role: "manager",
        status: "active",
        employmentType: mgr.employmentType,
      },
      create: {
        userId: user.id,
        organizationId: orgId,
        role: "manager",
        status: "active",
        employmentType: mgr.employmentType,
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

    const isFullTime = ["Alex Rivera", "Jamie Park", "Taylor Smith"].includes(staff.name);

    const membership = await tx.membership.upsert({
      where: {
        userId_organizationId: { userId: user.id, organizationId: orgId },
      },
      update: {
        role: "staff",
        status: "active",
        employmentType: isFullTime ? "full_time" : "casual",
      },
      create: {
        userId: user.id,
        organizationId: orgId,
        role: "staff",
        status: "active",
        employmentType: isFullTime ? "full_time" : "casual",
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
  // The roster, read back from the database
  // ============================================================
  // Read rather than accumulated, because staff are created in two places
  // above — the five with availability schedules, then the three extras — and
  // only the first five were ever collected. Every historical shift was
  // therefore worked by the same five people, which is also why the extras had
  // no history at all.
  //
  // Sorted by email so the generator below is deterministic regardless of what
  // order the database returns rows in.
  const rosterRows = await tx.membership.findMany({
    where: {
      organizationId: orgId,
      // Managers included: they are assignable to shifts, so leaving them out
      // gave them no history and a derived level of Junior on zero shifts.
      // Only company admins are excluded, and they cannot be assigned at all.
      role: { in: ["staff", "manager"] },
      status: "active",
    },
    select: {
      id: true,
      user: { select: { email: true } },
      departmentMemberships: { select: { departmentId: true } },
    },
  });

  const roster = rosterRows
    .map((m) => ({
      membershipId: m.id,
      email: m.user.email,
      departmentId: m.departmentMemberships[0]?.departmentId ?? null,
      cadence: SHIFT_CADENCE[m.user.email] ?? DEFAULT_CADENCE,
    }))
    .sort((a, b) => a.email.localeCompare(b.email));

  console.log(`Roster: ${roster.length} assignable members across ${departments.length} departments`);

  // ============================================================
  // Seniority override — the case derivation cannot solve alone
  // ============================================================
  // Riley has barely worked here, so every count says junior. In the story
  // this seed tells, Riley ran front of house somewhere else for years, and a
  // manager has said so explicitly. It is on the demo because it is the reason
  // the column exists: without it an experienced hire is locked out of the
  // shifts that would build the history that would qualify them.
  const riley = roster.find((r) => r.email === "riley@oceangrill.com");
  if (riley) {
    await tx.membership.update({
      where: { id: riley.membershipId },
      data: { seniorityOverride: "experienced" },
    });
    console.log("Pinned Riley to Experienced (external hire, no local history)");
  }

  // ============================================================
  // Custom roles
  // ============================================================
  /*
   * Two, because one cannot show what the model actually does.
   *
   * A fresh demo had NO custom roles at all, which left the headline feature of
   * this project describable and not demonstrable: an empty Roles page, and a
   * permission model that had to be explained rather than opened. Worse, the
   * guard added on 2026-08-08 — the one refusing a role that grants more than
   * its author holds — is invisible without somebody who holds `roles:manage`
   * through a custom role, because a company admin holds the whole catalogue
   * and is never constrained by it.
   *
   * So: one role that ADDS to a staff member, and one that DELEGATES the role
   * builder to a manager.
   *
   * Requires the permission catalogue. `npx prisma db seed` writes it and no
   * migration does, so a database that has never had it seeded produces roles
   * with nothing in them — which is why the missing names are named below
   * rather than silently skipped.
   */
  const customRoleData = [
    {
      name: "shift_lead",
      displayLabel: "Shift Lead",
      description:
        "A senior floor member who fills gaps in the roster without owning it",
      holderEmail: "alex@oceangrill.com",
      /*
       * Given to STAFF, who hold nothing by default — so this role is the whole
       * of what Alex can do, which is what makes it a clean demonstration of
       * "adds to the system bundle" rather than a subtle one.
       *
       * Filling a shift, not inventing one: no `tasks:create` or `tasks:delete`.
       * A shift lead covers the rota somebody else set.
       *
       * `calendar:view_team` also demonstrates the sidebar rule keyed on
       * PERMISSION rather than role — Alex gets Calendar and loses My Schedule,
       * exactly as a manager does.
       */
      permissions: [
        "tasks:assign",
        "eligibility:view",
        "calendar:view_team",
        "members:request_availability",
      ],
    },
    {
      name: "rota_manager",
      displayLabel: "Rota Manager",
      description:
        "A manager trusted to compose roles as well as rosters",
      holderEmail: "marcus@oceangrill.com",
      /*
       * The delegate account. Marcus holds the manager bundle already, so the
       * only thing this ADDS is the role builder — and that is the point: log in
       * as him, open Roles, and every permission outside a manager's reach is
       * greyed with "not yours to grant", while `audit:view` shows the
       * ENTERPRISE PLAN badge instead because the organisation is on Pro.
       *
       * Two independent gates, both denying, on one screen, for two different
       * reasons. That is the RBAC story this project is arguing, visible rather
       * than described.
       */
      permissions: ["roles:manage"],
    },
  ];

  const neededPermissions = [
    ...new Set(customRoleData.flatMap((r) => r.permissions)),
  ];
  const permissionRows = await tx.permission.findMany({
    where: { name: { in: neededPermissions } },
    select: { id: true, name: true },
  });
  const permissionIdByName = new Map(permissionRows.map((p) => [p.name, p.id]));

  const missing = neededPermissions.filter((n) => !permissionIdByName.has(n));
  if (missing.length > 0) {
    // Named, not counted. The catalogue comes from `prisma db seed`, and a
    // database missing it produces empty roles that look like a bug in the
    // roles page rather than an unseeded table.
    console.warn(
      `  ⚠ Permission catalogue is missing ${missing.length} entr${missing.length === 1 ? "y" : "ies"}: ` +
        `${missing.join(", ")}. Run \`npx prisma db seed\` and re-run this script.`
    );
  }

  for (const roleData of customRoleData) {
    const role = await tx.role.upsert({
      where: { organizationId_name: { organizationId: orgId, name: roleData.name } },
      update: {
        displayLabel: roleData.displayLabel,
        description: roleData.description,
      },
      create: {
        organizationId: orgId,
        name: roleData.name,
        displayLabel: roleData.displayLabel,
        description: roleData.description,
      },
    });

    // Replaced rather than added to, so re-running the seed after editing the
    // list above does not leave yesterday's permissions attached.
    await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
    await tx.rolePermission.createMany({
      data: roleData.permissions
        .map((name) => permissionIdByName.get(name))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId })),
    });

    const holder = await tx.membership.findFirst({
      where: { organizationId: orgId, user: { email: roleData.holderEmail } },
      select: { id: true },
    });
    if (holder) {
      await tx.membership.update({
        where: { id: holder.id },
        data: { customRoleId: role.id },
      });
    }
  }

  console.log(
    `Created ${customRoleData.length} custom roles: ` +
      customRoleData.map((r) => `${r.displayLabel} → ${r.holderEmail}`).join(", ")
  );

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
    /** Serialised JSON — see src/lib/composition-rules.ts. */
    compositionRules?: string;
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
      // The busiest shift of the day needs someone who has run one before.
      // Kitchen has two members past the senior threshold, so this is
      // satisfiable — and refuses the third assignment if a manager fills the
      // shift entirely with juniors and the newly experienced.
      compositionRules: JSON.stringify([
        { kind: "seniority", value: "senior", comparator: "at_least", count: 1 },
      ]),
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
      // The supervisor's own example, in the product: two people, and they
      // cannot both be junior. Demonstrable rather than described — assigning
      // a second junior is refused with the rule quoted back.
      compositionRules: JSON.stringify([
        { kind: "seniority", value: "junior", comparator: "at_most", count: 1 },
      ]),
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
        compositionRules: t.compositionRules ?? null,
        scheduledStart: start,
        scheduledEnd: end,
        createdById: adminUser.id,
      },
    });
  }

  /*
   * One upcoming shift with a LIVE withdrawal request on it.
   *
   * The five above are deliberately unassigned — they are what the allocation
   * engine is demonstrated against. So without this there was nowhere in the
   * demo for a genuinely pending withdrawal to live, and the only ones present
   * sat on shifts from months earlier, permanently unanswered.
   *
   * A separate task rather than an assignment on one of the five, so the "here
   * are five open shifts to allocate" story stays intact.
   */
  const pendingStart = new Date(tomorrow);
  pendingStart.setHours(18);
  const pendingEnd = new Date(tomorrow);
  pendingEnd.setHours(23);

  const pendingWithdrawalTask = await tx.task.create({
    data: {
      title: "Bar — Friday evening service",
      description: "Covered shift with an outstanding withdrawal request",
      organizationId: orgId,
      departmentId: departments[1]?.id ?? departments[0].id,
      priority: "high",
      requiredHeadcount: 1,
      scheduledStart: pendingStart,
      scheduledEnd: pendingEnd,
      createdById: adminUser.id,
    },
  });

  await tx.taskAssignment.create({
    data: {
      taskId: pendingWithdrawalTask.id,
      // Jordan — Bar, casual, and the transport reasons in the history are
      // already theirs, so the demo tells one story rather than three.
      membershipId: staffMembershipIds[3],
      assignedById: adminUser.id,
      status: "withdrawal_requested",
      withdrawalReason: "transport_issues",
      withdrawalNotes:
        "Last bus goes before we close — can someone else take the late finish?",
      withdrawalRequestedAt: new Date(),
      acceptedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
    },
  });

  console.log("Created 5 tasks for tomorrow, plus one with a pending withdrawal");

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
        allocationMode: "suggested",
        taskAcceptanceMode: "require_acceptance",
        workingDayHours: 8,
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
  // Shift history — 90 days
  // ============================================================
  // Built in memory and written with two createMany calls rather than ~900
  // sequential creates. Against Supabase every round trip costs real network
  // latency, and the whole seed runs inside one interactive transaction with a
  // 120-second ceiling; the row-at-a-time version would have spent most of it
  // waiting.
  //
  // Ids are deterministic rather than generated, so running the seed twice
  // produces a byte-identical database — the same reason the allocation
  // provenance above is derived from counters instead of random. The task
  // wipe higher up means they can never collide with an earlier run.
  console.log(`Creating ${HISTORY_DAYS} days of shift history...`);

  const now = new Date();
  const historyTasks: Prisma.TaskCreateManyInput[] = [];
  const historyAssignments: Prisma.TaskAssignmentCreateManyInput[] = [];

  for (let daysAgo = 1; daysAgo <= HISTORY_DAYS; daysAgo++) {
    const dayStart = new Date(now);
    dayStart.setDate(dayStart.getDate() - daysAgo);
    dayStart.setHours(0, 0, 0, 0);

    // Sundays the kitchen runs and the rest of the building does not, so the
    // coverage heatmap and the weekly charts have a shape rather than a
    // uniform block.
    const isSunday = dayStart.getDay() === 0;

    departments.forEach((dept, deptIndex) => {
      if (isSunday && deptIndex !== 0) return;

      const working = roster.filter(
        (r) => r.departmentId === dept.id && daysAgo % r.cadence === 0
      );
      if (working.length === 0) return;

      const startHour = 8 + deptIndex * 4;
      const start = new Date(dayStart);
      start.setHours(startHour);
      const end = new Date(dayStart);
      end.setHours(startHour + 6);

      // Offered five days before the shift. Response time is measured from
      // this moment, so it has to be a real instant rather than the default
      // now() every seeded row would otherwise share.
      const offeredAt = new Date(start.getTime() - 5 * 24 * 60 * 60 * 1000);
      const taskId = `seed-hist-${daysAgo}-${deptIndex}`;

      historyTasks.push({
        id: taskId,
        title: `${dept.name} shift — ${dayStart.toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
        })}`,
        description: "Worked shift, retained for reporting history",
        organizationId: orgId,
        departmentId: dept.id,
        priority: "medium",
        requiredHeadcount: working.length,
        scheduledStart: start,
        scheduledEnd: end,
        status: "completed",
        createdById: adminUser.id,
        createdAt: offeredAt,
      });

      working.forEach((member, i) => {
        const seed = daysAgo * 7 + deptIndex * 3 + i;
        const provenance = allocationProvenanceFor(seed);

        const lagHours = responseLagHoursFor(seed);
        const acceptedAt =
          lagHours === null
            ? null
            : new Date(offeredAt.getTime() + lagHours * 60 * 60 * 1000);

        // A thin slice of shifts someone accepted and then dropped out of.
        // Without these the withdrawal-notice figure on the response panel has
        // no data and renders an em dash.
        // Every 17th rather than every 41st: at the sparser rate the six
        // withdrawals that existed all fell outside the 30-day reporting
        // window, so the notice figure rendered an em dash on a database that
        // did contain withdrawals.
        // Set when a withdrawal was REQUESTED AND DENIED — the member worked
        // the shift, and the request stays on the row for reporting.
        let deniedWithdrawal: {
          withdrawalReason: string;
          withdrawalNotes: string;
          withdrawalRequestedAt: Date;
        } | null = null;

        const withdrew = seed % 17 === 0;
        if (withdrew) {
          /*
           * RESOLVED, because the shift has already happened.
           *
           * These were all seeded as `withdrawal_requested` and left there, so
           * a demo account opened in August showed "Awaiting your manager's
           * decision" on a shift from 30 May — and My Tasks lists by status
           * with no date test, so they never left the member's plate. A request
           * about a shift that has been and gone is not pending; it either got
           * covered or it did not.
           *
           * Two outcomes, because both are real and the screens read
           * differently for each. Approved becomes `withdrawn`, which releases
           * the slot — the member did not work it. Denied reverts to the
           * accepted path and the shift is worked like any other, which is what
           * `TaskAssignmentService` does when a manager says no.
           *
           * `withdrawalRequestedAt` is kept either way. Every reporting panel
           * reads that TIMESTAMP rather than the status, so resolving these
           * costs the withdrawal-notice figure nothing.
           */
          const approved = seed % 2 === 0;
          if (!approved) {
            // Denied: they worked it. Falls through to the completed path
            // below, carrying the request so the reporting window still sees
            // it.
            deniedWithdrawal = {
              withdrawalReason: withdrawalReasonFor(seed),
              withdrawalNotes: withdrawalNoteFor(seed),
              withdrawalRequestedAt: new Date(
                start.getTime() - (2 + (seed % 20)) * 60 * 60 * 1000
              ),
            };
          } else {
          historyAssignments.push({
            taskId,
            membershipId: member.membershipId,
            assignedById: adminUser.id,
            status: "withdrawn",
            withdrawalReason: withdrawalReasonFor(seed),
            // The notes, not the enum, are what the themes panel can read:
            // "transport_issues" on eleven rows is a GROUP BY, while the words
            // beside them are where the late-close problem is visible.
            withdrawalNotes: withdrawalNoteFor(seed),
            withdrawalRequestedAt: new Date(
              start.getTime() - (2 + (seed % 20)) * 60 * 60 * 1000
            ),
            createdAt: offeredAt,
            acceptedAt,
            ...provenance,
          });
          return;
          }
        }

        const clockIn = new Date(start);
        clockIn.setMinutes(clockIn.getMinutes() + 5 + i * 2);
        const clockOut = new Date(end);
        clockOut.setMinutes(clockOut.getMinutes() - 10 + i * 3);

        // Ratings only inside the 30-day reporting window. Seeding them across
        // the whole 90 days would put most of them outside every panel that
        // reads them, which looks like a bug in the panel rather than a
        // property of the data.
        const rating = daysAgo <= 30 ? ratingFor(seed, provenance.allocationRank) : null;

        historyAssignments.push({
          taskId,
          membershipId: member.membershipId,
          assignedById: adminUser.id,
          status: "completed",
          clockInTime: clockIn,
          clockOutTime: clockOut,
          createdAt: offeredAt,
          acceptedAt,
          ...(deniedWithdrawal ?? {}),
          ...(rating !== null
            ? {
                satisfactionRating: rating,
                // Roughly every third rated shift, and always when the
                // rating is low. Two reasons: people who rate a shift 1 or 2
                // are the ones who bother to say why, and at a flat one-in-
                // three the low ratings — which `ratingFor` makes rare on
                // purpose — produced no comments at all, so the only themes
                // findable in the demo were mild ones about deliveries.
                //
                // At every sixth, the 60-day window also held too few comments
                // to clear the panel's minimum, and it rendered nothing on a
                // database that plainly had feedback in it.
                satisfactionComment:
                  rating <= 2 || seed % 3 === 0 ? commentFor(rating, seed) : null,
                // Rated shortly after clocking out, which is when the control
                // actually appears on the staff member's task list.
                ratedAt: new Date(clockOut.getTime() + 20 * 60 * 1000),
              }
            : {}),
          ...provenance,
        });
      });
    });
  }

  await tx.task.createMany({ data: historyTasks });
  await tx.taskAssignment.createMany({ data: historyAssignments });

  const ratedCount = historyAssignments.filter((a) => a.satisfactionRating).length;
  console.log(
    `Created ${historyTasks.length} historical shifts, ` +
      `${historyAssignments.length} assignments, ${ratedCount} rated`
  );

  // ============================================================
  // Rejected assignments (for AI rejection pattern detection)
  // ============================================================
  console.log("Creating rejection data...");

  const recentTasks = await tx.task.findMany({
    where: { organizationId: orgId, status: "open" },
    take: 5,
  });

  const rejectionData = [
    { staffIndex: 0, taskIndex: 0, reason: "schedule_conflict", notes: "Have class until 3pm", rank: 1, score: 88 },
    { staffIndex: 0, taskIndex: 1, reason: "exceeds_preferred_hours", notes: "Already worked 35hrs this week", rank: 2, score: 71 },
    { staffIndex: 0, taskIndex: 2, reason: "schedule_conflict", notes: "Exam preparation", rank: 3, score: 64 },
    { staffIndex: 1, taskIndex: 0, reason: "feeling_unwell", rank: 2, score: 69 },
    { staffIndex: 1, taskIndex: 1, reason: "transport_issues", notes: "Bus route cancelled", rank: 4, score: 52 },
  ];

  for (const rej of rejectionData) {
    if (rej.taskIndex >= recentTasks.length) continue;

    const membershipId = staffMembershipIds[rej.staffIndex];
    const taskId = recentTasks[rej.taskIndex].id;

    const existingAssignment = await tx.taskAssignment.findUnique({
      where: { taskId_membershipId: { taskId, membershipId } },
    });
    if (existingAssignment) continue;

    // Some rejections come from engine picks, so "did the top pick hold up?"
    // has something to measure. A retention figure of a flat 100% would be
    // indistinguishable from the metric being broken.
    await tx.taskAssignment.create({
      data: {
        taskId,
        membershipId,
        assignedById: adminUser.id,
        status: "rejected",
        rejectionReason: rej.reason,
        rejectionNotes: rej.notes,
        // Declined a few hours after being offered. Without this the response
        // panel counts these as offers nobody ever answered, when in fact they
        // were answered promptly and the answer was no — which is a different
        // fact about the same organisation.
        rejectedAt: new Date(Date.now() - (2 + rej.rank) * 60 * 60 * 1000),
        allocationSource: "ai_suggested",
        allocationProvider: "groq",
        allocationRank: rej.rank,
        allocationScore: rej.score,
      },
    });
  }

  console.log("Created 5 rejected assignments (Alex: 3, Jamie: 2)");

  // ============================================================
  // Eligibility overrides (for the Engine Insights page)
  //
  // An override is the persisted trace of a manager disagreeing with the
  // constraint engine. Without a few of these the eligibility panel renders an
  // empty bar list, which reads as "the engine does nothing" rather than "this
  // database is new".
  //
  // Spread across rule types on purpose: a single rule would make the chart a
  // one-bar chart, which proves nothing about the breakdown working.
  // ============================================================
  console.log("Creating eligibility overrides...");

  const overrideFixtures = [
    { staffIndex: 0, taskIndex: 0, rule: "hours_limit", reason: "Short-staffed for the dinner rush; agreed the extra hour with Alex directly." },
    { staffIndex: 1, taskIndex: 1, rule: "availability", reason: "Jamie offered to cover outside their usual window." },
    { staffIndex: 2, taskIndex: 2, rule: "certification", reason: "Food Safety renewal is submitted and pending verification." },
    { staffIndex: 0, taskIndex: 3, rule: "hours_limit", reason: "Public holiday cover — approved by the duty manager." },
    { staffIndex: 1, taskIndex: 4, rule: "work_rules", reason: "Break taken earlier in the shift than the rule assumes." },
  ];

  for (const fixture of overrideFixtures) {
    if (fixture.taskIndex >= recentTasks.length) continue;
    if (fixture.staffIndex >= staffMembershipIds.length) continue;

    const membershipId = staffMembershipIds[fixture.staffIndex];
    const taskId = recentTasks[fixture.taskIndex].id;

    const existing = await tx.eligibilityOverride.findFirst({
      where: { taskId, membershipId, ruleOverridden: fixture.rule },
    });
    if (existing) continue;

    await tx.eligibilityOverride.create({
      data: {
        taskId,
        membershipId,
        overriddenById: adminUser.id,
        ruleOverridden: fixture.rule,
        reason: fixture.reason,
      },
    });
  }

  console.log("Created eligibility overrides across 4 rule types");

  // ============================================================
  // Leave requests — one in every state the register can show
  // ============================================================
  /*
   * Without these the entire leave feature is invisible in a demo: an empty
   * register, four tiles reading zero, a nav badge that never appears, and no
   * way to look at the thing the browser check is meant to check.
   *
   * Alex, Jamie and Taylor are the FULL-TIME staff, and all three are in
   * Kitchen — so Sarah sees them as a scoped manager and the admin sees them
   * org-wide. A casual member's override is written `approved` the moment they
   * save it and never reaches this queue, which is why the fixtures cannot use
   * Jordan or Casey.
   *
   * Written straight through Prisma rather than through `createOverride`,
   * deliberately: the service refuses a date already past, and correctly so.
   * A lapsed request can only be reached by a live one ageing into it, which a
   * seed cannot wait for.
   */

  /**
   * Midnight UTC of a Singapore calendar day — the shape `overrideDateKey`
   * produces, restated here because a seed must not import from `src/`.
   *
   * ## Why NOT `daysFromToday`, which is right there
   *
   * That helper returns the INSTANT of Singapore midnight, which is 16:00Z on
   * the previous day. This column stores a normalised KEY: midnight UTC of the
   * Singapore calendar date. The two are eight hours apart, and a row written
   * the first way would not collide with one the application later wrote the
   * second way for the same day — so the unique constraint on
   * `[membershipId, date]` would silently permit two overrides for one date.
   *
   * They read almost identically, which is exactly why this is written out
   * rather than reused.
   */
  const leaveDay = (dayOffset: number): Date => {
    const shifted = new Date(Date.now() + SGT_OFFSET_MS + dayOffset * DAY_MS);
    return new Date(
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
    );
  };

  /** Days rather than hours, on top of the `hoursAgo` declared above. */
  const agoDays = (n: number) => hoursAgo(n * 24);

  const leaveFixtures: {
    staffIndex: number;
    dayOffset: number;
    reason: string;
    status: string;
    submittedAt: Date;
    remindedAt?: Date;
    escalatedAt?: Date;
    lapseNotifiedAt?: Date;
    reviewed?: boolean;
    note: string;
  }[] = [
    /*
     * Awaiting, and genuinely calm. The date has to be beyond the 14-day
     * horizon AND the request younger than the 48-hour SLA, or it would show as
     * "closing soon" — which is most of the point of having both clocks.
     */
    {
      staffIndex: 0, dayOffset: 25, reason: "Family wedding", status: "pending",
      submittedAt: hoursAgo(3), note: "awaiting — far out and freshly asked",
    },
    /*
     * Closing soon by the HORIZON: asked for yesterday, but the date is inside
     * the fortnight the product already treats as live work.
     */
    {
      staffIndex: 1, dayOffset: 6, reason: "Hospital appointment", status: "pending",
      submittedAt: hoursAgo(20), note: "closing soon — date inside the horizon",
    },
    /*
     * Closing soon by the SLA: the date is months away, but nobody has looked
     * at it in five days. Chased once already, which is why `remindedAt` is set.
     */
    {
      staffIndex: 2, dayOffset: 45, reason: "Moving house", status: "pending",
      submittedAt: agoDays(5), remindedAt: agoDays(3),
      note: "closing soon — past its SLA, reminder sent",
    },
    /*
     * The headline state. Pending, its date gone, chased twice and answered by
     * nobody. Dismiss is the only verdict the register offers on it.
     */
    {
      staffIndex: 0, dayOffset: -6, reason: "Dentist", status: "pending",
      submittedAt: agoDays(20), remindedAt: agoDays(18), escalatedAt: agoDays(17),
      lapseNotifiedAt: agoDays(5),
      note: "LAPSED — nobody answered before the day arrived",
    },
    {
      staffIndex: 1, dayOffset: -20, reason: "Annual leave", status: "approved",
      submittedAt: agoDays(35), reviewed: true, note: "approved — history",
    },
    {
      staffIndex: 2, dayOffset: -27, reason: "Concert tickets", status: "rejected",
      submittedAt: agoDays(40), reviewed: true, note: "declined — history",
    },
    /*
     * Lapsed, then cleared. Carries a reviewer because somebody dismissed it,
     * and no notification was ever sent for the dismissal itself — there is
     * nothing true to tell a member beyond what their own screen already says.
     */
    {
      staffIndex: 0, dayOffset: -50, reason: "Car trouble", status: "dismissed",
      submittedAt: agoDays(60), remindedAt: agoDays(58), escalatedAt: agoDays(57),
      lapseNotifiedAt: agoDays(49), reviewed: true,
      note: "dismissed — a lapsed request somebody tidied away",
    },
  ];

  for (const fixture of leaveFixtures) {
    const membershipId = staffMembershipIds[fixture.staffIndex];
    const date = leaveDay(fixture.dayOffset);
    await tx.availabilityOverride.upsert({
      where: { membershipId_date: { membershipId, date } },
      update: {
        isAvailable: false,
        reason: fixture.reason,
        status: fixture.status,
        submittedAt: fixture.submittedAt,
        remindedAt: fixture.remindedAt ?? null,
        escalatedAt: fixture.escalatedAt ?? null,
        lapseNotifiedAt: fixture.lapseNotifiedAt ?? null,
        reviewedById: fixture.reviewed ? adminUser.id : null,
      },
      create: {
        membershipId,
        date,
        isAvailable: false,
        reason: fixture.reason,
        status: fixture.status,
        submittedAt: fixture.submittedAt,
        remindedAt: fixture.remindedAt ?? null,
        escalatedAt: fixture.escalatedAt ?? null,
        lapseNotifiedAt: fixture.lapseNotifiedAt ?? null,
        reviewedById: fixture.reviewed ? adminUser.id : null,
      },
    });
  }

  console.log(
    `Created ${leaveFixtures.length} leave requests: 1 awaiting, 2 closing soon, ` +
      "1 lapsed, 1 approved, 1 declined, 1 dismissed"
  );

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
  // Recognised certificates
  // ============================================================
  /*
   * The organisation's certificate vocabulary, derived from what this seed has
   * just written rather than listed again here.
   *
   * Derived on purpose: a hard-coded list would be a fourth place naming these
   * certificates, and the first one to drift from the other three. The names
   * come from the member certifications and task requirements above, so the
   * demo cannot contain a shift requiring something the picker does not offer —
   * which is the exact state this whole feature exists to make impossible.
   *
   * Inline rather than calling `CertificationTypeService`, because everything
   * in this file runs inside one interactive transaction and the service holds
   * its own client.
   */
  const certificateNames = new Map<string, string>();
  const [seededCerts, seededTasks] = await Promise.all([
    tx.certification.findMany({
      where: { membership: { organizationId: org.id } },
      select: { name: true },
    }),
    tx.task.findMany({
      where: { organizationId: org.id },
      select: { requiredCertifications: true },
    }),
  ]);
  const noteName = (raw: string) => {
    const name = raw.trim();
    if (name && !certificateNames.has(name.toLowerCase())) {
      certificateNames.set(name.toLowerCase(), name);
    }
  };
  seededCerts.forEach((c) => noteName(c.name));
  seededTasks.forEach((t) => (t.requiredCertifications ?? []).forEach(noteName));

  for (const name of certificateNames.values()) {
    await tx.certificationType.upsert({
      where: { organizationId_name: { organizationId: org.id, name } },
      update: {},
      create: { organizationId: org.id, name },
    });
  }
  console.log(
    `Recognised certificates: ${certificateNames.size} (${[...certificateNames.values()].join(", ")})`
  );

  // ============================================================
  // A SECOND organisation — the one that makes multi-tenancy visible
  // ============================================================
  /*
   * Every account in this seed belonged to exactly one organisation, so the
   * product's central claim — that it is multi-tenant — could not be
   * demonstrated, and the code paths that depend on it could not be exercised
   * by hand. `orgs[0]` was wrong for months in three files and nothing in the
   * demo data could show it.
   *
   * Two things make this organisation worth its rows:
   *
   * **A different plan.** Ocean Grill is Pro, Harbour Cafe is Free. Switching
   * between them is the only way to watch the sidebar gain and lose Roles,
   * Audit Log and the Export PDF button without editing the database by hand —
   * which is what the browser checklist has been asking people to do.
   *
   * **A different ROLE for the same person.** Sarah is a manager at Ocean
   * Grill and plain staff here. That is the exact failure the org layout was
   * written for: permissions resolved from the user rather than from the
   * organisation in the URL gave her Ocean Grill's menu on Harbour Cafe's
   * pages. One account, two answers, and the only way to be sure the right one
   * is being used is to have a person for whom they differ.
   */
  let secondOrg = await tx.organization.findUnique({
    where: { slug: "harbour-cafe" },
  });
  if (!secondOrg) {
    secondOrg = await tx.organization.create({
      data: {
        name: "Harbour Cafe",
        slug: "harbour-cafe",
        industry: "Hospitality",
        description: "A small quayside coffee shop",
      },
    });
  }
  // Stated rather than left to the column default, so the contrast with Ocean
  // Grill is a fact of the seed and survives a change to that default.
  await tx.organization.update({
    where: { id: secondOrg.id },
    data: { subscriptionTier: "free" },
  });

  await tx.membership.upsert({
    where: {
      userId_organizationId: {
        userId: adminUser.id,
        organizationId: secondOrg.id,
      },
    },
    update: { role: "company_admin", status: "active", employmentType: "casual" },
    create: {
      userId: adminUser.id,
      organizationId: secondOrg.id,
      role: "company_admin",
      status: "active",
      employmentType: "casual",
    },
  });

  const counterDept = await tx.department.upsert({
    where: {
      organizationId_name: { organizationId: secondOrg.id, name: "Counter" },
    },
    update: {},
    create: {
      name: "Counter",
      description: "Coffee, service and till",
      color: "#8B5CF6",
      organizationId: secondOrg.id,
    },
  });

  const sarahUserId = managerUserIds["Sarah Chen"];
  if (sarahUserId) {
    const sarahHere = await tx.membership.upsert({
      where: {
        userId_organizationId: {
          userId: sarahUserId,
          organizationId: secondOrg.id,
        },
      },
      // Staff HERE, manager at Ocean Grill. The point of the account.
      update: { role: "staff", status: "active", employmentType: "casual" },
      create: {
        userId: sarahUserId,
        organizationId: secondOrg.id,
        role: "staff",
        status: "active",
        employmentType: "casual",
      },
    });

    const alreadyInCounter = await tx.departmentMembership.findUnique({
      where: {
        membershipId_departmentId: {
          membershipId: sarahHere.id,
          departmentId: counterDept.id,
        },
      },
    });
    if (!alreadyInCounter) {
      await tx.departmentMembership.create({
        data: { membershipId: sarahHere.id, departmentId: counterDept.id },
      });
    }
  }

  /*
   * Two shifts, so the dashboard here has something in it. Deliberately few:
   * this organisation exists to be switched INTO, and a second full rota would
   * double the seed's runtime to prove a point one shift already proves.
   */
  const cafeShiftCount = await tx.task.count({
    where: { organizationId: secondOrg.id },
  });
  if (cafeShiftCount === 0) {
    const openingStart = new Date();
    openingStart.setDate(openingStart.getDate() + 1);
    openingStart.setHours(7, 0, 0, 0);
    const openingEnd = new Date(openingStart);
    openingEnd.setHours(12, 0, 0, 0);

    const closingStart = new Date(openingStart);
    closingStart.setHours(12, 0, 0, 0);
    const closingEnd = new Date(openingStart);
    closingEnd.setHours(17, 0, 0, 0);

    await tx.task.createMany({
      data: [
        {
          title: "Morning open",
          description: "Grinder, pastries, till float",
          organizationId: secondOrg.id,
          departmentId: counterDept.id,
          createdById: adminUser.id,
          status: "open",
          priority: "high",
          requiredHeadcount: 1,
          scheduledStart: openingStart,
          scheduledEnd: openingEnd,
        },
        {
          title: "Afternoon close",
          description: "Service, clean down, cash up",
          organizationId: secondOrg.id,
          departmentId: counterDept.id,
          createdById: adminUser.id,
          status: "open",
          priority: "medium",
          requiredHeadcount: 1,
          scheduledStart: closingStart,
          scheduledEnd: closingEnd,
        },
      ],
    });
  }
  console.log("Second organisation ready: Harbour Cafe (Free tier)");

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
  console.log("  Staff:    alex@oceangrill.com (Kitchen, Full-time, Morning Mon-Fri)");
  console.log("  Staff:    jamie@oceangrill.com (Kitchen, Full-time, Evening Mon-Sat)");
  console.log("  Staff:    taylor@oceangrill.com (Kitchen, Full-time, Full day Mon-Fri)");
  console.log("  Staff:    jordan@oceangrill.com (Bar, Casual, Part time Wed-Sun)");
  console.log("  Staff:    casey@oceangrill.com (Front of House, Casual, Flexible all week)");
  console.log("  Staff:    sam@oceangrill.com (Bar, Casual)");
  console.log("  Staff:    riley@oceangrill.com (Front of House, Casual)");
  console.log("  Staff:    morgan@oceangrill.com (Kitchen, Casual)");
  console.log("  New user: new@smarttask.com (No org — lands on onboarding)");
  console.log("\nTwo organisations:");
  console.log("  Ocean Grill   — Pro   — admin is company admin, Sarah is a manager");
  console.log("  Harbour Cafe  — Free  — admin is company admin, Sarah is STAFF");
  console.log("  admin@ and sarah@ both land on the organisation picker at sign-in.");
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
