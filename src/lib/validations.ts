/**
 * Zod Validation Schemas (Boundary Layer)
 * 
 * Input validation and sanitization for all API endpoints.
 * These schemas enforce data integrity at the Boundary layer
 * before data reaches the Control (service) layer.
 * 
 * Security: Prevents malformed input from reaching business logic.
 */
import { z } from "zod";
import { DECLINE_REASONS } from "@/lib/decline-reasons";
import { compositionRulesSchema } from "@/lib/composition-rules";
import { FEEDBACK_AREAS, FEEDBACK_MAX_LENGTH } from "@/lib/feedback-areas";
import { SENIORITY_LEVELS } from "@/lib/seniority";

/**
 * Reusable password schema enforcing strong password policy:
 * - Minimum 8 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 * - At least one special character
 */
const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[0-9]/, "Password must contain at least one number")
  .regex(/[^A-Za-z0-9]/, "Password must contain at least one special character");

// ============================================================
// Phase 1: Authentication & Organization Schemas
// ============================================================

/** Validates new user registration with password confirmation */
export const registerSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(100),
    email: z.string().email("Invalid email address"),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

/**
 * Validates a new account created by accepting an invitation.
 *
 * Same name bounds and the same `passwordSchema` as registration. This route
 * had NO schema at all — `body.password` went straight to bcrypt — so an
 * invited user could set a one-character password, and `name` was unbounded
 * where registration caps it at 100. The account is auto-verified on
 * acceptance, so it is a full member from the first request.
 *
 * No `confirmPassword`: the invitation form is a single field, and a mismatch
 * check the client never sends would refuse every legitimate request.
 */
export const acceptInvitationSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  password: passwordSchema,
});

/** Validates login credentials */
export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

/** Validates forgot password request */
export const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
});

/** Validates password reset with token and password confirmation */
export const resetPasswordSchema = z
  .object({
    token: z.string().min(1, "Token is required"),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

/** Validates new organization creation */
export const createOrganizationSchema = z.object({
  name: z.string().min(1, "Organization name is required").max(100),
  industry: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
});

/** Validates a Stripe checkout request for a paid plan. */
/**
 * Moving an existing subscription between paid plans.
 *
 * No `interval` — this changes the PLAN, not the cadence. Someone switching
 * Enterprise to Pro has not asked to be moved from annual to monthly, and
 * accepting a field for it invites a caller to change what they pay next
 * without them choosing to.
 */
export const changePlanSchema = z.object({
  plan: z.enum(["pro", "enterprise"]),
});

export const createCheckoutSchema = z.object({
  interval: z.enum(["month", "year"]),
  source: z.enum(["onboarding", "settings", "billing"]),
  // Existing onboarding requests did not include a plan, so they remain Pro.
  plan: z.enum(["pro", "enterprise"]).default("pro"),
});

/** 
 * Validates profile updates.
 * Password change requires current password for verification.
 * New password must match confirmation.
 */
export const updateProfileSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(100).optional(),
    currentPassword: z.string().optional(),
    newPassword: passwordSchema.optional(),
    confirmNewPassword: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.newPassword && !data.currentPassword) return false;
      return true;
    },
    {
      message: "Current password is required to set a new password",
      path: ["currentPassword"],
    }
  )
  .refine(
    (data) => {
      if (data.newPassword && data.newPassword !== data.confirmNewPassword)
        return false;
      return true;
    },
    {
      message: "Passwords do not match",
      path: ["confirmNewPassword"],
    }
  );

// ============================================================
// Phase 2: Department, Invitation & User Management Schemas
// ============================================================

/** Validates new department creation within an organization */
export const createDepartmentSchema = z.object({
  name: z.string().min(1, "Department name is required").max(100),
  description: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Must be a hex color like #FF5733").optional(),
});

/** Validates department updates — all fields optional for partial updates */
export const updateDepartmentSchema = z.object({
  name: z.string().min(1, "Department name is required").max(100).optional(),
  description: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Must be a hex color like #FF5733").optional(),
});

/** 
 * Validates user invitation by Company Admin.
 * Only manager and staff roles can be invited — company_admin is 
 * assigned only during org creation (self-registration).
 * Department assignment is optional at invitation time.
 */
export const inviteUserSchema = z.object({
  email: z.string().email("Invalid email address"),
  role: z.enum(["manager", "staff"]),
  departmentId: z.string().optional(),
  departmentIds: z.array(z.string().min(1)).min(1, "Select at least one department").max(20).optional(),
  participantMembershipIds: z.array(z.string().min(1)).max(100).optional(),
  employmentType: z.enum(["full_time", "casual"]).optional(),
});

/**
 * Validates user role updates by Company Admin.
 * Supports reassigning to any role including company_admin.
 * departmentIds allows assigning managers to multiple departments.
 */
export const updateUserRoleSchema = z.object({
  role: z.enum(["company_admin", "manager", "staff"]),
  departmentIds: z.array(z.string()).optional(),
  employmentType: z.enum(["full_time", "casual"]).optional(),
  customRoleId: z.string().nullable().optional(),
});

/** 
 * Validates organization profile updates by Company Admin.
 * Logo is a URL field (file upload deferred to Phase 8).
 */
export const updateOrganizationSchema = z.object({
  name: z.string().min(1, "Organization name is required").max(100).optional(),
  industry: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  logo: z.string().url("Invalid URL").optional().or(z.literal("")),
  address: z.string().max(500).optional(),
});

// ============================================================
// Phase 3: Role Management & Company Settings Schemas
// ============================================================

/** Validates custom role creation with permission assignments */
/**
 * Validates a new custom role.
 *
 * `name` is GONE from the input. The form used to ask for it alongside the
 * label, annotated "Used in code. Lowercase, no spaces." — and nothing read it,
 * nothing validated the format, and `updateRoleSchema` never allowed changing
 * it. It is now derived from the label; see `src/lib/role-slug.ts`.
 *
 * The label must contain at least one letter or digit. Without that, "!!!" or a
 * bare emoji is a legal role name that slugifies to nothing, and the service
 * would have no stored name to write.
 */
export const createRoleSchema = z.object({
  displayLabel: z
    .string()
    .min(1, "Role name is required")
    .max(50)
    .refine((v) => /[a-zA-Z0-9]/.test(v), {
      message: "Role name needs at least one letter or number",
    }),
  description: z.string().max(500).optional(),
  permissionIds: z.array(z.string()).min(1, "At least one permission is required"),
});

/** Validates role updates — all fields optional for partial updates */
export const updateRoleSchema = z.object({
  displayLabel: z
    .string()
    .min(1, "Role name is required")
    .max(50)
    .refine((v) => /[a-zA-Z0-9]/.test(v), {
      message: "Role name needs at least one letter or number",
    })
    .optional(),
  description: z.string().max(500).optional(),
  permissionIds: z.array(z.string()).optional(),
});

/**
 * Validates company settings updates.
 * allocationMode: suggested (a human assigns, shown the engine's ranking) or
 * auto (the engine assigns). Presented as "Manual" and "Auto".
 *
 * `taskAcceptanceMode` was removed on 2026-08-13. Rostering is automatic and a
 * member who cannot work a shift asks to withdraw from it, so the mode that
 * made every assignment wait on an acceptance was a second way to express a
 * refusal the product already handled after the fact.
 *
 * Operating hours are two plain hour integers, and ANY pair is legal. There is
 * deliberately no cross-field rule that the end must be after the start:
 * `end <= start` means the window runs past midnight, which is how a business
 * open 20:00–04:00 states its hours. Requiring end > start made a night-time
 * operation literally unable to describe itself, and — because
 * `operatingHoursStart` is also the organisation's day boundary — forced every
 * organisation onto a boundary somewhere in the morning.
 *
 * See `@/lib/business-day` for how the pair is interpreted.
 */
export const updateCompanySettingsSchema = z.object({
  allocationMode: z.enum(["suggested", "auto"]).optional(),
  workingDayHours: z.number().int().min(1).max(24).optional(),
  operatingHoursStart: z.number().int().min(0).max(23).optional(),
  operatingHoursEnd: z.number().int().min(1).max(24).optional(),
  // Completed-shift counts at which a member becomes experienced, then senior.
  // Each is bounded here; the rule that senior must exceed experienced lives in
  // the service, because it has to be checked against the MERGED values — a
  // request raising only one of the two would otherwise pass with the other
  // left where it was.
  experiencedShiftThreshold: z.number().int().min(1).max(500).optional(),
  seniorShiftThreshold: z.number().int().min(1).max(500).optional(),
  /*
   * Every key optional and every absent key meaning "enabled", which is what
   * `NotificationService.isTypeEnabled` already assumes — so adding a key here
   * needs no migration and no backfill: an organisation whose stored JSON
   * predates the key keeps receiving the notification until it says otherwise.
   */
  notificationPreferences: z.object({
    emailNotifications: z.boolean().optional(),
    taskAssignment: z.boolean().optional(),
    // Shortfalls: partly staffed and not staffed. Separate from taskAssignment
    // because that one is staff-facing news about their own shifts and this is
    // a manager's queue of work to fix.
    taskStaffing: z.boolean().optional(),
    // The outcome of a withdrawal. The REQUEST is never gated — see the note
    // beside TYPE_TO_PREFERENCE in notification.service.
    taskWithdrawal: z.boolean().optional(),
    taskRejection: z.boolean().optional(),
    hourLimitWarning: z.boolean().optional(),
    certificationExpiry: z.boolean().optional(),
  }).optional(),
  /*
   * How much each dimension counts when the engine ranks candidates.
   *
   * Bounded 0–100 per key here, but NOT required to total 100: ranking depends
   * only on the ratio between them, so they are normalised at the point of use.
   * Four sliders forced to sum to a constant make every adjustment an
   * arithmetic problem for the person moving them.
   *
   * The two rules that need the merged object — "not all zero" and "no single
   * dimension dominating" — live in the service, for the same reason the
   * seniority thresholds do: a request sending one key must be checked against
   * the three it left alone.
   */
  smartAllocationWeights: z.object({
    workload: z.number().min(0).max(100),
    availability: z.number().min(0).max(100),
    certifications: z.number().min(0).max(100),
    department: z.number().min(0).max(100),
  }).optional(),
});

// ============================================================
// Phase 4: Task Management & Assignment Schemas
// ============================================================

/** Validates new task creation */
/**
 * An ISO 8601 instant, with or without a timezone offset.
 *
 * ## Why `offset: true` is not optional here
 *
 * Zod's bare `.datetime()` accepts ONLY a `Z` time and rejects
 * "2026-08-26T15:00:00+08:00". The AI task parser deliberately produces the
 * second form — its prompt says "Return ISO 8601 WITH the offset… Never return
 * a bare Z time — it would be read as UTC and land hours away from what the
 * user asked for" — so the application's own parser emitted values its own
 * create endpoint refused.
 *
 * That went unnoticed for as long as a form sat between them: the parsed value
 * was loaded into a `datetime-local` input and submitted as
 * `new Date(value).toISOString()`, which is a `Z` string. The moment a clean
 * parse began creating the task directly, the mismatch became "Validation
 * failed" on every AI Create with a time in it.
 *
 * Widening rather than normalising at the call site, because the narrowness
 * bought nothing: both forms are the same instant, `new Date()` reads them
 * identically, and requiring `Z` only means every caller must remember to
 * convert — which is the bug, restated.
 */
const isoInstant = z.string().datetime({ offset: true });

export const createTaskSchema = z.object({
  title: z.string().min(1, "Title is required").max(200),
  description: z.string().max(2000).optional(),
  departmentId: z.string().optional(),
  projectId: z.string().optional(),
  requiredHeadcount: z.number().int().min(1).max(50).optional(),
  requiredCertifications: z.array(z.string().min(1).max(200)).max(20).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  scheduledStart: isoInstant.optional(),
  scheduledEnd: isoInstant.optional(),
  isRecurring: z.boolean().optional(),
  recurringPattern: z.string().max(200).optional(),
  // Constraints on the SET of assignees rather than on each of them. The
  // schema lives in lib/composition-rules.ts beside the evaluator, so the
  // shape the API accepts and the shape the engine reads cannot drift.
  compositionRules: compositionRulesSchema.optional(),
});

/** Validates task updates — all fields optional for partial updates */
export const updateTaskSchema = z.object({
  title: z.string().min(1, "Title is required").max(200).optional(),
  description: z.string().max(2000).optional(),
  // Nullable, not merely optional: omitting the key means "leave unchanged",
  // while an explicit null (or "") means "clear the department". Without the
  // null branch a task could never be moved back to "No department".
  departmentId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  requiredHeadcount: z.number().int().min(1).max(50).optional(),
  requiredCertifications: z.array(z.string().min(1).max(200)).max(20).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  status: z.enum(["open", "in_progress", "completed", "cancelled"]).optional(),
  // Same widening as create — an edit that re-sends a parsed time must not be
  // refused where the create accepted it.
  scheduledStart: isoInstant.optional().or(z.literal("")),
  scheduledEnd: isoInstant.optional().or(z.literal("")),
  /*
   * Position in the project's running order. Presentation only — nothing gates
   * on it — so it is bounded rather than validated against siblings: a gap or a
   * duplicate sorts harmlessly and is not worth a read-modify-write of every
   * task in the project to prevent.
   */
  orderIndex: z.number().int().min(0).max(10000).optional(),
  // An empty array is meaningful and distinct from omission: it clears every
  // rule. Omitting the key leaves them untouched.
  compositionRules: compositionRulesSchema.optional(),
});

/** Validates staff assignment to a task */
export const assignTaskSchema = z.object({
  membershipIds: z.array(z.string()).min(1, "Select at least one staff member"),
});

export const createProjectSchema = z.object({
  title: z.string().trim().min(1, "Project title is required").max(200),
  description: z.string().trim().max(4000).optional(),
  departmentId: z.string().optional(),
  departmentIds: z.array(z.string()).min(1).max(50).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  staffingMode: z.enum(["task_based", "project_team"]).default("task_based"),
  plannedStart: z.string().datetime().optional(),
  plannedEnd: z.string().datetime().optional(),
});

export const updateProjectSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).optional(),
  departmentId: z.string().nullable().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  staffingMode: z.enum(["task_based", "project_team"]).optional(),
  status: z.enum(["planning", "active", "on_hold", "completed", "cancelled"]).optional(),
  plannedStart: z.string().datetime().optional().or(z.literal("")),
  plannedEnd: z.string().datetime().optional().or(z.literal("")),
});

export const setProjectTeamSchema = z.object({
  membershipIds: z.array(z.string().min(1)).max(100, "A project team cannot contain more than 100 members"),
});

/**
 * Validates task rejection with required reason.
 *
 * The eight values come from `@/lib/decline-reasons` rather than being written
 * out here. They were previously duplicated in this enum, in the My Tasks
 * dropdown and in the PDF report's label map, with nothing keeping the three in
 * step — a value added here would not have appeared in the dropdown, and one
 * removed would have left the dropdown offering something this schema rejects.
 */
export const rejectTaskSchema = z.object({
  rejectionReason: z.enum(DECLINE_REASONS),
  rejectionNotes: z.string().max(500).optional(),
});

/**
 * Validates a staff withdrawal request on an accepted assignment.
 *
 * The reason was free text until now. It is the same question rejection asks —
 * "why can you not work this shift" — so it takes the same eight values, and
 * for the same reason: free text cannot be counted. "Schedule conflict" typed
 * six different ways is six categories, which makes the withdrawal figures on
 * the admin dashboard meaningless.
 *
 * `notes` preserves what the free-text field was actually good for. A bare
 * "personal_reasons" tells the manager approving it nothing, so the box stays —
 * it is simply no longer the only thing recorded.
 */
export const withdrawTaskSchema = z.object({
  reason: z.enum(DECLINE_REASONS),
  notes: z.string().max(500).optional(),
});

/**
 * Validates a staff member's rating of a shift they worked.
 *
 * The 1–5 bound is stated in three places — here, in the service, and as a
 * CHECK constraint in the database. That is deliberate rather than redundant:
 * this one produces a useful 400, the service one holds for any future caller
 * that bypasses the route, and the database one survives both.
 */
export const rateShiftSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
});

/**
 * Validates a manager pinning a member's seniority.
 *
 * Nullable, not merely optional. Null is the instruction "stop overriding and
 * go back to deriving from completed shifts", which is a different request
 * from omitting the field, and without it a pinned level could never be
 * released.
 */
export const seniorityOverrideSchema = z.object({
  seniorityOverride: z.enum(SENIORITY_LEVELS).nullable(),
});

/** Validates a manager's decision on a pending withdrawal request */
export const withdrawalDecisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
});

/**
 * Validates a manager's decision on a full-time member's decline request.
 *
 * Same shape as the withdrawal decision and deliberately a separate export:
 * they are decisions on different things at different points in the lifecycle,
 * and aliasing them would make a later divergence — a required note on refusal,
 * say — look like a change to both.
 */
export const declineDecisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
});

// ============================================================
// Phase 5: Availability, Certification & Eligibility Schemas
// ============================================================

/** Validates weekly availability schedule entry */
export const setAvailabilitySchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM format"),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM format"),
  isAvailable: z.boolean(),
});

/** Validates bulk availability update (full week) */
export const setWeeklyAvailabilitySchema = z.object({
  schedule: z.array(setAvailabilitySchema).min(1).max(7),
});

/** Validates a date-specific availability override */
export const createAvailabilityOverrideSchema = z.object({
  date: z.string().datetime(),
  isAvailable: z.boolean(),
  reason: z.string().max(500).optional(),
});

/** Validates certification submission */
export const createCertificationSchema = z.object({
  name: z.string().min(1, "Certification name is required").max(200),
  issuedDate: z.string().datetime(),
  expiryDate: z.string().datetime().optional(),
  documentUrl: z.string().url().optional(),
});

/**
 * Predefined certificate rejection reasons, mirroring the task-rejection
 * pattern (fixed set + optional notes) so both are reportable rather than
 * free text. Also used when revoking an already-verified certificate.
 */
export const CERTIFICATION_REJECTION_REASONS = [
  "certificate_expired",
  "document_unreadable",
  "wrong_certification",
  "details_mismatch",
  "not_recognised",
  "other",
] as const;

/**
 * Validates a manager's decision on a PENDING certification.
 * A rejection must say why — "rejected" with no reason leaves the employee
 * nothing to act on, which is the whole point of telling them.
 */
export const verifyCertificationSchema = z
  .object({
    status: z.enum(["verified", "rejected"]),
    rejectionReason: z.enum(CERTIFICATION_REJECTION_REASONS).optional(),
    rejectionNotes: z.string().max(500).optional(),
  })
  .refine(
    (data) => data.status !== "rejected" || Boolean(data.rejectionReason),
    {
      message: "A reason is required when rejecting a certification",
      path: ["rejectionReason"],
    }
  );

/**
 * Validates revoking a VERIFIED certification. Revocation is a status change,
 * never a delete: the eligibility engine used this record to decide who could
 * work which shifts, so the row has to survive for the audit trail.
 */
export const revokeCertificationSchema = z.object({
  rejectionReason: z.enum(CERTIFICATION_REJECTION_REASONS),
  rejectionNotes: z.string().max(500).optional(),
});

/** Validates eligibility override with required reason */
export const createEligibilityOverrideSchema = z.object({
  membershipId: z.string().min(1),
  reason: z.string().min(1, "Override reason is required").max(500),
  // "all" overrides every warning for the member on this task (used by the
  // assignment override flow); the specific keys target a single dimension.
  ruleOverridden: z.enum([
    "hours_limit",
    "availability",
    "scheduling",
    "work_rules",
    "certification",
    // Not a per-candidate dimension like the five above — it waives a rule
    // about the SHAPE of the roster. Recorded against a membership all the
    // same, because the override is a decision to let THIS person on despite
    // it, and "who was waved through" is the question the audit answers.
    "composition",
    "all",
  ]),
});

// ============================================================
// Phase 8: Work Rules
// ============================================================

export const workRuleTypes = ["break_interval", "max_hours_daily", "max_hours_weekly"] as const;

export const createWorkRuleSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  type: z.enum(workRuleTypes),
  roleId: z.string().optional().nullable(),
  departmentId: z.string().optional().nullable(),
  hoursThreshold: z.number().positive().optional().nullable(),
  breakHours: z.number().positive().optional().nullable(),
  maxHours: z.number().positive().optional().nullable(),
  isActive: z.boolean().optional(),
});

export const updateWorkRuleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.enum(workRuleTypes).optional(),
  roleId: z.string().optional().nullable(),
  departmentId: z.string().optional().nullable(),
  hoursThreshold: z.number().positive().optional().nullable(),
  breakHours: z.number().positive().optional().nullable(),
  maxHours: z.number().positive().optional().nullable(),
  isActive: z.boolean().optional(),
});

// ============================================================
// Phase 10: Mass Import
// ============================================================

/** Validates a single member row in a batch import */
export const importMemberSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(100),
  email: z.string().email("Invalid email address"),
  role: z.enum(["staff", "manager"]),
  departmentName: z.string().max(100).nullable(),
  employmentType: z.enum(["full_time", "casual"]),
});

/** Validates the full batch import request */
export const batchImportSchema = z.object({
  members: z.array(importMemberSchema).min(1, "At least one member required").max(200, "Maximum 200 members per import"),
});

// ============================================================
// Type Exports — inferred from schemas for type-safe usage
// ============================================================
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
/**
 * Notification feed query parameters.
 *
 * Query strings arrive as strings or not at all, so limit/offset are coerced
 * and clamped here rather than in the route. An out-of-range page size is a
 * client mistake, not a server error — it is clamped, not rejected, so the
 * feed always renders.
 */
export const notificationFeedQuerySchema = z.object({
  category: z
    .enum(["task", "assignment", "certification", "alert"])
    .optional(),
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  /*
   * The keyset cursor for "load older" — the last row the client already has.
   *
   * `datetime` rather than a loose string: an unparseable value would become
   * `new Date(NaN)`, and every comparison against NaN is false, so the query
   * would silently return nothing and the page would report it had reached the
   * end. A 400 says what happened.
   *
   * `offset` stays for the first page and for callers paging a stable list.
   */
  beforeCreatedAt: z.string().datetime().optional(),
  beforeId: z.string().min(1).max(64).optional(),
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
export type InviteUserInput = z.infer<typeof inviteUserSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type UpdateCompanySettingsInput = z.infer<typeof updateCompanySettingsSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type AssignTaskInput = z.infer<typeof assignTaskSchema>;
export type RejectTaskInput = z.infer<typeof rejectTaskSchema>;
export type SetAvailabilityInput = z.infer<typeof setAvailabilitySchema>;
export type SetWeeklyAvailabilityInput = z.infer<typeof setWeeklyAvailabilitySchema>;
export type CreateAvailabilityOverrideInput = z.infer<typeof createAvailabilityOverrideSchema>;
export type CreateCertificationInput = z.infer<typeof createCertificationSchema>;
export type VerifyCertificationInput = z.infer<typeof verifyCertificationSchema>;
export type RevokeCertificationInput = z.infer<typeof revokeCertificationSchema>;
export type CertificationRejectionReason =
  (typeof CERTIFICATION_REJECTION_REASONS)[number];
export type CreateEligibilityOverrideInput = z.infer<typeof createEligibilityOverrideSchema>;
export type CreateWorkRuleInput = z.infer<typeof createWorkRuleSchema>;
export type UpdateWorkRuleInput = z.infer<typeof updateWorkRuleSchema>;
export type ImportMemberInput = z.infer<typeof importMemberSchema>;
export type BatchImportInput = z.infer<typeof batchImportSchema>;
export type NotificationFeedQuery = z.infer<typeof notificationFeedQuerySchema>;

/**
 * A clock correction.
 *
 * Both times are REQUIRED keys and nullable values, deliberately. Prisma reads
 * `undefined` as "leave alone", so an optional field would make clearing a
 * wrongly-entered clock-in impossible to express — the caller would send
 * nothing and the old value would survive. `null` is how you erase one, and the
 * schema makes the caller say which they mean.
 */
export const correctClockSchema = z.object({
  clockInTime: z.string().datetime().nullable(),
  clockOutTime: z.string().datetime().nullable(),
  reason: z.string().trim().min(1, "A reason is required").max(500),
});


/**
 * Product feedback from a member.
 *
 * `area` is an enum rather than free text so counting it stays SQL's job. The
 * length cap is enforced here as well as in the service: the service owns the
 * rule, this owns the 400 — a caller who sends a novel should be told why
 * before any of it is trimmed.
 */
export const submitFeedbackSchema = z.object({
  area: z.enum(FEEDBACK_AREAS),
  message: z.string().trim().min(1, "Feedback cannot be empty").max(FEEDBACK_MAX_LENGTH),
});

/** Archive, or put it back. Required rather than optional — see `correctClockSchema`. */
export const archiveFeedbackSchema = z.object({
  archived: z.boolean(),
});

export const createFaqSchema = z.object({
  question: z.string().trim().min(1, "A question is required").max(200),
  answer: z.string().trim().min(1, "An answer is required").max(2000),
});

/**
 * Every field optional, because this endpoint serves four different edits:
 * rewording, reordering, publishing and unpublishing. `.strict()` is not used
 * elsewhere here, so an unknown key is ignored rather than refused.
 */
export const updateFaqSchema = z.object({
  question: z.string().trim().min(1).max(200).optional(),
  answer: z.string().trim().min(1).max(2000).optional(),
  position: z.number().int().min(0).max(9999).optional(),
  published: z.boolean().optional(),
});

export type SubmitFeedbackInput = z.infer<typeof submitFeedbackSchema>;
export type CreateFaqInput = z.infer<typeof createFaqSchema>;
export type UpdateFaqInput = z.infer<typeof updateFaqSchema>;


/**
 * A question from the landing page.
 *
 * `website` is a honeypot: hidden from people, filled by scripts. It is part of
 * the schema rather than checked ad hoc in the route so that a caller sending
 * an unexpected shape is refused here, before anything reads it.
 */
export const askQuestionSchema = z.object({
  body: z.string().trim().min(1, "Please write your question").max(1000),
  email: z.string().trim().max(254).optional(),
  name: z.string().trim().max(120).optional(),
  website: z.string().optional(),
});

/** Dealt with, or back on the list. Required rather than optional. */
export const handleQuestionSchema = z.object({
  handled: z.boolean(),
});

export type AskQuestionInput = z.infer<typeof askQuestionSchema>;


/**
 * A customer review.
 *
 * The rating is an integer 1–5 here as well as in the service: the column is a
 * plain Int and cannot express the range, so refusing 0 or 6 at the boundary is
 * what stops one reaching the landing page and rendering as no stars at all.
 */
export const submitReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().trim().min(1, "Please write a few words").max(600),
});

/** Approve or reject. "pending" is not offered — an edit is what returns it. */
export const moderateReviewSchema = z.object({
  status: z.enum(["approved", "rejected"]),
});

export type SubmitReviewInput = z.infer<typeof submitReviewSchema>;
