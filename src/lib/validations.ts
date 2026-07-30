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

/** Validates a Stripe checkout request for the Pro plan */
export const createCheckoutSchema = z.object({
  interval: z.enum(["month", "year"]),
  source: z.enum(["onboarding", "settings"]),
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
export const createRoleSchema = z.object({
  name: z.string().min(1, "Role name is required").max(50),
  displayLabel: z.string().min(1, "Display label is required").max(50),
  description: z.string().max(500).optional(),
  permissionIds: z.array(z.string()).min(1, "At least one permission is required"),
});

/** Validates role updates — all fields optional for partial updates */
export const updateRoleSchema = z.object({
  displayLabel: z.string().min(1, "Display label is required").max(50).optional(),
  description: z.string().max(500).optional(),
  permissionIds: z.array(z.string()).optional(),
});

/**
 * Validates company settings updates.
 * allocationMode: manual (admin picks), suggested (AI suggests), auto (AI assigns)
 * taskAcceptanceMode: auto_accept (instant) or require_acceptance (staff confirms)
 */
export const updateCompanySettingsSchema = z.object({
  allocationMode: z.enum(["manual", "suggested", "auto"]).optional(),
  taskAcceptanceMode: z.enum(["auto_accept", "require_acceptance"]).optional(),
  breakRuleHoursWorked: z.number().int().min(1).max(24).optional(),
  breakRuleBreakHours: z.number().int().min(1).max(24).optional(),
  operatingHoursStart: z.number().int().min(0).max(23).optional(),
  operatingHoursEnd: z.number().int().min(1).max(24).optional(),
  notificationPreferences: z.object({
    emailNotifications: z.boolean().optional(),
    taskAssignment: z.boolean().optional(),
    taskRejection: z.boolean().optional(),
    hourLimitWarning: z.boolean().optional(),
    certificationExpiry: z.boolean().optional(),
  }).optional(),
});

// ============================================================
// Phase 4: Task Management & Assignment Schemas
// ============================================================

/** Validates new task creation */
export const createTaskSchema = z.object({
  title: z.string().min(1, "Title is required").max(200),
  description: z.string().max(2000).optional(),
  departmentId: z.string().optional(),
  requiredHeadcount: z.number().int().min(1).max(50).optional(),
  requiredCertifications: z.array(z.string().min(1).max(200)).max(20).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  scheduledStart: z.string().datetime().optional(),
  scheduledEnd: z.string().datetime().optional(),
  isRecurring: z.boolean().optional(),
  recurringPattern: z.string().max(200).optional(),
});

/** Validates task updates — all fields optional for partial updates */
export const updateTaskSchema = z.object({
  title: z.string().min(1, "Title is required").max(200).optional(),
  description: z.string().max(2000).optional(),
  departmentId: z.string().optional(),
  requiredHeadcount: z.number().int().min(1).max(50).optional(),
  requiredCertifications: z.array(z.string().min(1).max(200)).max(20).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  status: z.enum(["open", "in_progress", "completed", "cancelled"]).optional(),
  scheduledStart: z.string().datetime().optional().or(z.literal("")),
  scheduledEnd: z.string().datetime().optional().or(z.literal("")),
});

/** Validates staff assignment to a task */
export const assignTaskSchema = z.object({
  membershipIds: z.array(z.string()).min(1, "Select at least one staff member"),
});

/** Validates task rejection with required reason */
export const rejectTaskSchema = z.object({
  rejectionReason: z.enum([
    "schedule_conflict",
    "feeling_unwell",
    "exceeds_preferred_hours",
    "transport_issues",
    "insufficient_notice",
    "rest_period_needed",
    "personal_reasons",
    "other",
  ]),
  rejectionNotes: z.string().max(500).optional(),
});

/** Validates a staff withdrawal/abort request on an accepted assignment */
export const withdrawTaskSchema = z.object({
  reason: z.string().min(3, "Please give a brief reason").max(500),
});

/** Validates a manager's decision on a pending withdrawal request */
export const withdrawalDecisionSchema = z.object({
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
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
export type InviteUserInput = z.infer<typeof inviteUserSchema>;
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type UpdateCompanySettingsInput = z.infer<typeof updateCompanySettingsSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
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
