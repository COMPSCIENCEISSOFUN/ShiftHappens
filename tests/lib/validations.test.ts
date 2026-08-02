/**
 * Tests for Zod Validation Schemas
 *
 * Covers all input validation rules for auth, org, department,
 * invitation, user management, tasks, availability, certifications,
 * eligibility overrides, and company settings (including operating hours).
 */
import { describe, it, expect } from "vitest";
import { DECLINE_REASONS } from "@/lib/decline-reasons";
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  createOrganizationSchema,
  updateProfileSchema,
  createDepartmentSchema,
  updateDepartmentSchema,
  inviteUserSchema,
  updateUserRoleSchema,
  updateOrganizationSchema,
  createRoleSchema,
  updateRoleSchema,
  updateCompanySettingsSchema,
  createTaskSchema,
  updateTaskSchema,
  assignTaskSchema,
  rejectTaskSchema,
  setAvailabilitySchema,
  setWeeklyAvailabilitySchema,
  createAvailabilityOverrideSchema,
  createCertificationSchema,
  verifyCertificationSchema,
  revokeCertificationSchema,
  createEligibilityOverrideSchema,
  createCheckoutSchema,
  withdrawTaskSchema,
  withdrawalDecisionSchema,
} from "@/lib/validations";

describe("registerSchema", () => {
  it("accepts valid registration data", () => {
    const result = registerSchema.safeParse({
      name: "John Doe",
      email: "john@example.com",
      password: "SecurePass1!",
      confirmPassword: "SecurePass1!",
    });
    expect(result.success).toBe(true);
  });

  it("rejects mismatched passwords", () => {
    const result = registerSchema.safeParse({
      name: "John Doe",
      email: "john@example.com",
      password: "SecurePass1!",
      confirmPassword: "DifferentPass1!",
    });
    expect(result.success).toBe(false);
  });

  it("rejects weak passwords", () => {
    const result = registerSchema.safeParse({
      name: "John Doe",
      email: "john@example.com",
      password: "weak",
      confirmPassword: "weak",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid email", () => {
    const result = registerSchema.safeParse({
      name: "John Doe",
      email: "not-an-email",
      password: "SecurePass1!",
      confirmPassword: "SecurePass1!",
    });
    expect(result.success).toBe(false);
  });
});

describe("loginSchema", () => {
  it("accepts valid login data", () => {
    const result = loginSchema.safeParse({
      email: "john@example.com",
      password: "SecurePass1!",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty password", () => {
    const result = loginSchema.safeParse({
      email: "john@example.com",
      password: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("forgotPasswordSchema", () => {
  it("accepts valid email", () => {
    const result = forgotPasswordSchema.safeParse({
      email: "john@example.com",
    });
    expect(result.success).toBe(true);
  });
});

describe("resetPasswordSchema", () => {
  it("accepts valid reset data", () => {
    const result = resetPasswordSchema.safeParse({
      token: "valid-token",
      password: "NewSecure1!",
      confirmPassword: "NewSecure1!",
    });
    expect(result.success).toBe(true);
  });

  it("rejects mismatched passwords", () => {
    const result = resetPasswordSchema.safeParse({
      token: "valid-token",
      password: "NewSecure1!",
      confirmPassword: "Different1!",
    });
    expect(result.success).toBe(false);
  });
});

describe("createOrganizationSchema", () => {
  it("accepts valid organization data", () => {
    const result = createOrganizationSchema.safeParse({
      name: "Acme Corp",
      industry: "Technology",
      description: "A tech company",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = createOrganizationSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });
});

describe("updateProfileSchema", () => {
  it("accepts valid profile update", () => {
    const result = updateProfileSchema.safeParse({ name: "Jane Doe" });
    expect(result.success).toBe(true);
  });

  it("accepts password change with matching passwords", () => {
    const result = updateProfileSchema.safeParse({
      name: "Jane Doe",
      currentPassword: "OldPass1!",
      newPassword: "NewPass1!",
      confirmNewPassword: "NewPass1!",
    });
    expect(result.success).toBe(true);
  });

  it("rejects password change without current password", () => {
    const result = updateProfileSchema.safeParse({
      name: "Jane Doe",
      newPassword: "NewPass1!",
      confirmNewPassword: "NewPass1!",
    });
    expect(result.success).toBe(false);
  });
});

describe("createDepartmentSchema", () => {
  it("accepts valid department data", () => {
    const result = createDepartmentSchema.safeParse({
      name: "Engineering",
      description: "The engineering team",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = createDepartmentSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });
});

describe("updateDepartmentSchema", () => {
  it("accepts partial update", () => {
    const result = updateDepartmentSchema.safeParse({ name: "New Name" });
    expect(result.success).toBe(true);
  });
});

describe("inviteUserSchema", () => {
  it("accepts valid invitation", () => {
    const result = inviteUserSchema.safeParse({ email: "john@example.com", role: "staff" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid role", () => {
    const result = inviteUserSchema.safeParse({ email: "john@example.com", role: "superadmin" });
    expect(result.success).toBe(false);
  });

  it("accepts invitation with department", () => {
    const result = inviteUserSchema.safeParse({ email: "john@example.com", role: "manager", departmentId: "dept-123" });
    expect(result.success).toBe(true);
  });

  it("accepts invitation with employmentType full_time", () => {
    const result = inviteUserSchema.safeParse({ email: "john@example.com", role: "staff", employmentType: "full_time" });
    expect(result.success).toBe(true);
  });

  it("accepts invitation with employmentType casual", () => {
    const result = inviteUserSchema.safeParse({ email: "john@example.com", role: "staff", employmentType: "casual" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid employmentType", () => {
    const result = inviteUserSchema.safeParse({ email: "john@example.com", role: "staff", employmentType: "contract" });
    expect(result.success).toBe(false);
  });

  it("accepts invitation without employmentType (optional)", () => {
    const result = inviteUserSchema.safeParse({ email: "john@example.com", role: "staff" });
    expect(result.success).toBe(true);
  });
});

describe("updateUserRoleSchema", () => {
  it("accepts valid role update", () => {
    const result = updateUserRoleSchema.safeParse({ role: "manager", departmentIds: ["dept-1", "dept-2"] });
    expect(result.success).toBe(true);
  });

  it("rejects invalid role", () => {
    const result = updateUserRoleSchema.safeParse({ role: "owner" });
    expect(result.success).toBe(false);
  });

  it("accepts role update with employmentType", () => {
    const result = updateUserRoleSchema.safeParse({ role: "staff", employmentType: "full_time" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid employmentType on role update", () => {
    const result = updateUserRoleSchema.safeParse({ role: "staff", employmentType: "permanent" });
    expect(result.success).toBe(false);
  });

  it("accepts role update with customRoleId string", () => {
    const result = updateUserRoleSchema.safeParse({ role: "staff", customRoleId: "role-123" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.customRoleId).toBe("role-123");
    }
  });

  it("accepts role update with customRoleId null (clears custom role)", () => {
    const result = updateUserRoleSchema.safeParse({ role: "staff", customRoleId: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.customRoleId).toBeNull();
    }
  });

  it("accepts role update without customRoleId (optional)", () => {
    const result = updateUserRoleSchema.safeParse({ role: "staff" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.customRoleId).toBeUndefined();
    }
  });
});

describe("updateOrganizationSchema", () => {
  it("accepts valid org update", () => {
    const result = updateOrganizationSchema.safeParse({ name: "New Corp", industry: "Finance" });
    expect(result.success).toBe(true);
  });

  it("accepts valid logo URL", () => {
    const result = updateOrganizationSchema.safeParse({ logo: "https://example.com/logo.png" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid logo URL", () => {
    const result = updateOrganizationSchema.safeParse({ logo: "not-a-url" });
    expect(result.success).toBe(false);
  });
});

describe("createRoleSchema", () => {
  it("accepts valid role data", () => {
    const result = createRoleSchema.safeParse({
      name: "shift_lead", displayLabel: "Shift Lead", description: "Leads a shift", permissionIds: ["perm-1", "perm-2"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = createRoleSchema.safeParse({ name: "", displayLabel: "Shift Lead", permissionIds: ["perm-1"] });
    expect(result.success).toBe(false);
  });

  it("rejects empty permissions", () => {
    const result = createRoleSchema.safeParse({ name: "shift_lead", displayLabel: "Shift Lead", permissionIds: [] });
    expect(result.success).toBe(false);
  });
});

describe("updateRoleSchema", () => {
  it("accepts partial update", () => {
    const result = updateRoleSchema.safeParse({ displayLabel: "Senior Shift Lead" });
    expect(result.success).toBe(true);
  });

  it("accepts permission update", () => {
    const result = updateRoleSchema.safeParse({ permissionIds: ["perm-1", "perm-2", "perm-3"] });
    expect(result.success).toBe(true);
  });
});

describe("updateCompanySettingsSchema", () => {
  it("accepts valid settings", () => {
    const result = updateCompanySettingsSchema.safeParse({
      allocationMode: "suggested", taskAcceptanceMode: "require_acceptance",
      breakRuleHoursWorked: 6, breakRuleBreakHours: 10,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid allocation mode", () => {
    const result = updateCompanySettingsSchema.safeParse({ allocationMode: "invalid_mode" });
    expect(result.success).toBe(false);
  });

  it("accepts notification preferences", () => {
    const result = updateCompanySettingsSchema.safeParse({
      notificationPreferences: { emailNotifications: true, taskAssignment: true, hourLimitWarning: false },
    });
    expect(result.success).toBe(true);
  });

  it("rejects break hours above 24", () => {
    const result = updateCompanySettingsSchema.safeParse({ breakRuleHoursWorked: 25 });
    expect(result.success).toBe(false);
  });

  describe("operating hours validation", () => {
    it("accepts valid operating hours", () => {
      const result = updateCompanySettingsSchema.safeParse({ operatingHoursStart: 8, operatingHoursEnd: 20 });
      expect(result.success).toBe(true);
    });

    it("accepts start=0 (midnight opening)", () => {
      const result = updateCompanySettingsSchema.safeParse({ operatingHoursStart: 0 });
      expect(result.success).toBe(true);
    });

    it("accepts end=24 (midnight closing)", () => {
      const result = updateCompanySettingsSchema.safeParse({ operatingHoursEnd: 24 });
      expect(result.success).toBe(true);
    });

    it("accepts boundary values start=23, end=24", () => {
      const result = updateCompanySettingsSchema.safeParse({ operatingHoursStart: 23, operatingHoursEnd: 24 });
      expect(result.success).toBe(true);
    });

    it("rejects operatingHoursStart below 0", () => {
      const result = updateCompanySettingsSchema.safeParse({ operatingHoursStart: -1 });
      expect(result.success).toBe(false);
    });

    it("rejects operatingHoursStart above 23", () => {
      const result = updateCompanySettingsSchema.safeParse({ operatingHoursStart: 24 });
      expect(result.success).toBe(false);
    });

    it("rejects operatingHoursEnd below 1", () => {
      const result = updateCompanySettingsSchema.safeParse({ operatingHoursEnd: 0 });
      expect(result.success).toBe(false);
    });

    it("rejects operatingHoursEnd above 24", () => {
      const result = updateCompanySettingsSchema.safeParse({ operatingHoursEnd: 25 });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer operatingHoursStart", () => {
      const result = updateCompanySettingsSchema.safeParse({ operatingHoursStart: 8.5 });
      expect(result.success).toBe(false);
    });
  });
});

describe("createTaskSchema", () => {
  it("accepts valid task data", () => {
    const result = createTaskSchema.safeParse({ title: "Clean kitchen", description: "Deep clean", priority: "high", requiredHeadcount: 2 });
    expect(result.success).toBe(true);
  });

  it("rejects empty title", () => {
    const result = createTaskSchema.safeParse({ title: "" });
    expect(result.success).toBe(false);
  });

  it("accepts task with scheduling", () => {
    const result = createTaskSchema.safeParse({ title: "Morning prep", scheduledStart: "2026-06-01T08:00:00.000Z", scheduledEnd: "2026-06-01T10:00:00.000Z" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid priority", () => {
    const result = createTaskSchema.safeParse({ title: "Task", priority: "super_urgent" });
    expect(result.success).toBe(false);
  });

  it("rejects headcount above 50", () => {
    const result = createTaskSchema.safeParse({ title: "Task", requiredHeadcount: 51 });
    expect(result.success).toBe(false);
  });

  it("accepts a list of required certifications", () => {
    const result = createTaskSchema.safeParse({
      title: "Task",
      requiredCertifications: ["Food Safety", "RSA Certification"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty certification names", () => {
    const result = createTaskSchema.safeParse({
      title: "Task",
      requiredCertifications: [""],
    });
    expect(result.success).toBe(false);
  });
});

describe("updateTaskSchema", () => {
  it("accepts partial update", () => {
    const result = updateTaskSchema.safeParse({ title: "Updated title", priority: "urgent" });
    expect(result.success).toBe(true);
  });

  it("accepts status update", () => {
    const result = updateTaskSchema.safeParse({ status: "completed" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid status", () => {
    const result = updateTaskSchema.safeParse({ status: "deleted" });
    expect(result.success).toBe(false);
  });
});

describe("assignTaskSchema", () => {
  it("accepts valid assignment", () => {
    const result = assignTaskSchema.safeParse({ membershipIds: ["member-1", "member-2"] });
    expect(result.success).toBe(true);
  });

  it("rejects empty assignment", () => {
    const result = assignTaskSchema.safeParse({ membershipIds: [] });
    expect(result.success).toBe(false);
  });
});

describe("rejectTaskSchema", () => {
  it("accepts valid rejection", () => {
    const result = rejectTaskSchema.safeParse({ rejectionReason: "schedule_conflict" });
    expect(result.success).toBe(true);
  });

  it("rejects empty reason", () => {
    const result = rejectTaskSchema.safeParse({ rejectionReason: "" });
    expect(result.success).toBe(false);
  });
});

describe("setAvailabilitySchema", () => {
  it("accepts valid availability", () => {
    const result = setAvailabilitySchema.safeParse({ dayOfWeek: 1, startTime: "09:00", endTime: "17:00", isAvailable: true });
    expect(result.success).toBe(true);
  });

  it("rejects invalid day", () => {
    const result = setAvailabilitySchema.safeParse({ dayOfWeek: 7, startTime: "09:00", endTime: "17:00", isAvailable: true });
    expect(result.success).toBe(false);
  });

  it("rejects invalid time format", () => {
    const result = setAvailabilitySchema.safeParse({ dayOfWeek: 1, startTime: "9am", endTime: "5pm", isAvailable: true });
    expect(result.success).toBe(false);
  });
});

describe("setWeeklyAvailabilitySchema", () => {
  it("accepts full week schedule", () => {
    const schedule = Array.from({ length: 7 }, (_, i) => ({ dayOfWeek: i, startTime: "09:00", endTime: "17:00", isAvailable: i < 5 }));
    const result = setWeeklyAvailabilitySchema.safeParse({ schedule });
    expect(result.success).toBe(true);
  });

  it("rejects empty schedule", () => {
    const result = setWeeklyAvailabilitySchema.safeParse({ schedule: [] });
    expect(result.success).toBe(false);
  });
});

describe("createAvailabilityOverrideSchema", () => {
  it("accepts valid override", () => {
    const result = createAvailabilityOverrideSchema.safeParse({ date: "2026-06-15T00:00:00.000Z", isAvailable: false, reason: "Personal day off" });
    expect(result.success).toBe(true);
  });

  it("accepts override without reason", () => {
    const result = createAvailabilityOverrideSchema.safeParse({ date: "2026-06-15T00:00:00.000Z", isAvailable: true });
    expect(result.success).toBe(true);
  });
});

describe("createCertificationSchema", () => {
  it("accepts valid certification", () => {
    const result = createCertificationSchema.safeParse({ name: "Food Safety Level 2", issuedDate: "2026-01-15T00:00:00.000Z", expiryDate: "2027-01-15T00:00:00.000Z" });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = createCertificationSchema.safeParse({ name: "", issuedDate: "2026-01-15T00:00:00.000Z" });
    expect(result.success).toBe(false);
  });

  it("accepts certification without expiry", () => {
    const result = createCertificationSchema.safeParse({ name: "First Aid", issuedDate: "2026-01-15T00:00:00.000Z" });
    expect(result.success).toBe(true);
  });
});

describe("verifyCertificationSchema", () => {
  it("accepts verified status with no reason", () => {
    const result = verifyCertificationSchema.safeParse({ status: "verified" });
    expect(result.success).toBe(true);
  });

  it("accepts rejected status when a reason is given", () => {
    const result = verifyCertificationSchema.safeParse({
      status: "rejected",
      rejectionReason: "document_unreadable",
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional notes alongside a reason", () => {
    const result = verifyCertificationSchema.safeParse({
      status: "rejected",
      rejectionReason: "certificate_expired",
      rejectionNotes: "Lapsed in 2024 — please submit the refresher.",
    });
    expect(result.success).toBe(true);
  });

  it("REJECTS a rejection with no reason", () => {
    // The whole point of the reason: "rejected" on its own tells the employee
    // nothing they can act on. Enforced here rather than only in the service so
    // a malformed request never reaches the Control layer.
    const result = verifyCertificationSchema.safeParse({ status: "rejected" });
    expect(result.success).toBe(false);
    if (!result.success) {
      // safeParse puts the issues on result.error, not on result itself.
      expect(result.error.issues[0].path).toEqual(["rejectionReason"]);
    }
  });

  it("rejects an unknown reason", () => {
    const result = verifyCertificationSchema.safeParse({
      status: "rejected",
      rejectionReason: "just_because",
    });
    expect(result.success).toBe(false);
  });

  it("rejects notes longer than 500 characters", () => {
    const result = verifyCertificationSchema.safeParse({
      status: "rejected",
      rejectionReason: "other",
      rejectionNotes: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid status", () => {
    const result = verifyCertificationSchema.safeParse({ status: "approved" });
    expect(result.success).toBe(false);
  });

  it("rejects 'revoked' — revocation is a separate transition", () => {
    // PATCH decides a pending submission; POST withdraws one already honoured.
    const result = verifyCertificationSchema.safeParse({ status: "revoked" });
    expect(result.success).toBe(false);
  });
});

describe("revokeCertificationSchema", () => {
  it("accepts a reason", () => {
    const result = revokeCertificationSchema.safeParse({
      rejectionReason: "not_recognised",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a reason with notes", () => {
    const result = revokeCertificationSchema.safeParse({
      rejectionReason: "details_mismatch",
      rejectionNotes: "Name on the certificate does not match the employee.",
    });
    expect(result.success).toBe(true);
  });

  it("requires a reason — revoking removes someone's eligibility", () => {
    const result = revokeCertificationSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects an unknown reason", () => {
    const result = revokeCertificationSchema.safeParse({
      rejectionReason: "changed_my_mind",
    });
    expect(result.success).toBe(false);
  });
});

describe("createEligibilityOverrideSchema", () => {
  it("accepts valid override", () => {
    const result = createEligibilityOverrideSchema.safeParse({ membershipId: "member-123", reason: "Manager approved exception", ruleOverridden: "hours_limit" });
    expect(result.success).toBe(true);
  });

  it("rejects empty reason", () => {
    const result = createEligibilityOverrideSchema.safeParse({ membershipId: "member-123", reason: "", ruleOverridden: "certification" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid rule", () => {
    const result = createEligibilityOverrideSchema.safeParse({ membershipId: "member-123", reason: "Special case", ruleOverridden: "invalid_rule" });
    expect(result.success).toBe(false);
  });

  it("accepts the 'scheduling' rule", () => {
    const result = createEligibilityOverrideSchema.safeParse({ membershipId: "member-123", reason: "Manager approved", ruleOverridden: "scheduling" });
    expect(result.success).toBe(true);
  });

  it("accepts the 'work_rules' rule", () => {
    const result = createEligibilityOverrideSchema.safeParse({ membershipId: "member-123", reason: "Manager approved", ruleOverridden: "work_rules" });
    expect(result.success).toBe(true);
  });

  it("accepts the 'all' rule (blanket override)", () => {
    const result = createEligibilityOverrideSchema.safeParse({ membershipId: "member-123", reason: "Manager approved", ruleOverridden: "all" });
    expect(result.success).toBe(true);
  });
});

describe("createCheckoutSchema", () => {
  it("accepts a monthly checkout from onboarding", () => {
    const result = createCheckoutSchema.safeParse({ interval: "month", source: "onboarding" });
    expect(result.success).toBe(true);
  });

  it("accepts a yearly checkout from settings", () => {
    const result = createCheckoutSchema.safeParse({ interval: "year", source: "settings" });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid interval", () => {
    const result = createCheckoutSchema.safeParse({ interval: "week", source: "settings" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid source", () => {
    const result = createCheckoutSchema.safeParse({ interval: "month", source: "email" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing source", () => {
    const result = createCheckoutSchema.safeParse({ interval: "month" });
    expect(result.success).toBe(false);
  });
});

/**
 * Withdrawal reasons were free text ("Family emergency") until they became one
 * of the eight shared DECLINE_REASONS. Free text cannot be counted — "schedule
 * conflict" typed six ways is six categories — and withdrawal reasons are meant
 * to feed the admin dashboard's allocation-accuracy figures.
 *
 * The free-text box survives as `notes`, because "personal_reasons" on its own
 * tells the manager approving the request nothing.
 */
describe("withdrawTaskSchema", () => {
  it("accepts one of the shared decline reasons", () => {
    const result = withdrawTaskSchema.safeParse({ reason: "schedule_conflict" });
    expect(result.success).toBe(true);
  });

  it("accepts a reason with optional notes", () => {
    const result = withdrawTaskSchema.safeParse({
      reason: "personal_reasons",
      notes: "Sister's wedding, booked months ago",
    });
    expect(result.success).toBe(true);
  });

  it("no longer accepts free text as the reason", () => {
    // The behaviour change, stated directly so it reads as a decision rather
    // than as something that quietly stopped working.
    const result = withdrawTaskSchema.safeParse({ reason: "Family emergency" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing reason", () => {
    expect(withdrawTaskSchema.safeParse({}).success).toBe(false);
  });

  it("rejects notes over 500 characters", () => {
    const result = withdrawTaskSchema.safeParse({
      reason: "other",
      notes: "a".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("accepts every reason the dropdown offers", () => {
    // Guards the actual failure mode of the old duplication: a value the UI
    // shows that the schema refuses, leaving the staff member stuck on
    // "Validation failed" with no way to proceed.
    for (const reason of DECLINE_REASONS) {
      expect(withdrawTaskSchema.safeParse({ reason }).success).toBe(true);
    }
  });
});

describe("rejectTaskSchema accepts every shared reason", () => {
  it("matches the dropdown exactly", () => {
    for (const reason of DECLINE_REASONS) {
      const result = rejectTaskSchema.safeParse({ rejectionReason: reason });
      expect(result.success).toBe(true);
    }
  });

  it("still refuses a reason that is not in the list", () => {
    const result = rejectTaskSchema.safeParse({ rejectionReason: "just_because" });
    expect(result.success).toBe(false);
  });
});

describe("withdrawalDecisionSchema", () => {
  it("accepts 'approve'", () => {
    const result = withdrawalDecisionSchema.safeParse({ decision: "approve" });
    expect(result.success).toBe(true);
  });

  it("accepts 'deny'", () => {
    const result = withdrawalDecisionSchema.safeParse({ decision: "deny" });
    expect(result.success).toBe(true);
  });

  it("rejects any other decision", () => {
    const result = withdrawalDecisionSchema.safeParse({ decision: "maybe" });
    expect(result.success).toBe(false);
  });
});