export const PERMISSIONS = {
  DEPARTMENTS_CREATE: "departments:create",
  DEPARTMENTS_READ: "departments:read",
  DEPARTMENTS_UPDATE: "departments:update",
  DEPARTMENTS_DELETE: "departments:delete",
  MEMBERS_READ: "members:read",
  MEMBERS_INVITE: "members:invite",
  MEMBERS_UPDATE_ROLE: "members:update_role",
  MEMBERS_DEACTIVATE: "members:deactivate",
  TASKS_CREATE: "tasks:create",
  TASKS_READ: "tasks:read",
  TASKS_UPDATE: "tasks:update",
  TASKS_DELETE: "tasks:delete",
  TASKS_ASSIGN: "tasks:assign",
  TASKS_ACCEPT_REJECT: "tasks:accept_reject",
  TASKS_CLOCK: "tasks:clock",
  ELIGIBILITY_VIEW: "eligibility:view",
  ELIGIBILITY_OVERRIDE: "eligibility:override",
  ALLOCATION_USE_SUGGESTIONS: "allocation:use_suggestions",
  ALLOCATION_AUTO_ALLOCATE: "allocation:auto_allocate",
  REPORTS_VIEW: "reports:view",
  REPORTS_EXPORT: "reports:export",
  CALENDAR_VIEW: "calendar:view",
  CALENDAR_MANAGE_AVAILABILITY: "calendar:manage_availability",
  NOTIFICATIONS_RECEIVE: "notifications:receive",
  NOTIFICATIONS_MANAGE: "notifications:manage",
  SETTINGS_READ: "settings:read",
  SETTINGS_UPDATE: "settings:update",
  ROLES_CREATE: "roles:create",
  ROLES_READ: "roles:read",
  ROLES_UPDATE: "roles:update",
  ROLES_DELETE: "roles:delete",
  ORGANIZATION_READ: "organization:read",
  ORGANIZATION_UPDATE: "organization:update",
  AUDIT_VIEW: "audit:view",
  WORK_RULES_READ: "work_rules:read",
  WORK_RULES_MANAGE: "work_rules:manage",
  CERTIFICATIONS_READ: "certifications:read",
  CERTIFICATIONS_REVIEW: "certifications:review",
  CERTIFICATIONS_MANAGE_DEFINITIONS: "certifications:manage_definitions",
  SCHEDULE_GENERATE: "schedule:generate",
  BILLING_MANAGE: "billing:manage",
} as const;

export type PermissionName = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export interface PermissionMembership {
  role: string;
  customRoleId?: string | null;
  customRole?: {
    rolePermissions: { permission: { name: string } }[];
  } | null;
}

const MANAGER_PERMISSIONS = new Set<PermissionName>([
  PERMISSIONS.DEPARTMENTS_READ,
  PERMISSIONS.MEMBERS_READ,
  PERMISSIONS.TASKS_CREATE,
  PERMISSIONS.TASKS_READ,
  PERMISSIONS.TASKS_UPDATE,
  PERMISSIONS.TASKS_DELETE,
  PERMISSIONS.TASKS_ASSIGN,
  PERMISSIONS.ELIGIBILITY_VIEW,
  PERMISSIONS.ELIGIBILITY_OVERRIDE,
  PERMISSIONS.ALLOCATION_USE_SUGGESTIONS,
  PERMISSIONS.ALLOCATION_AUTO_ALLOCATE,
  PERMISSIONS.REPORTS_VIEW,
  PERMISSIONS.REPORTS_EXPORT,
  PERMISSIONS.CALENDAR_VIEW,
  PERMISSIONS.CALENDAR_MANAGE_AVAILABILITY,
  PERMISSIONS.NOTIFICATIONS_RECEIVE,
  PERMISSIONS.NOTIFICATIONS_MANAGE,
  PERMISSIONS.ORGANIZATION_READ,
  PERMISSIONS.CERTIFICATIONS_READ,
  PERMISSIONS.CERTIFICATIONS_REVIEW,
  PERMISSIONS.SCHEDULE_GENERATE,
]);

const STAFF_PERMISSIONS = new Set<PermissionName>([
  PERMISSIONS.DEPARTMENTS_READ,
  PERMISSIONS.CALENDAR_MANAGE_AVAILABILITY,
  PERMISSIONS.NOTIFICATIONS_RECEIVE,
  PERMISSIONS.NOTIFICATIONS_MANAGE,
  PERMISSIONS.ORGANIZATION_READ,
]);

const SUPPORTED_PERMISSIONS = new Set<PermissionName>(
  Object.values(PERMISSIONS)
);

export function effectivePermissions(
  membership: PermissionMembership
): Set<string> {
  if (membership.role === "company_admin") {
    return new Set(SUPPORTED_PERMISSIONS);
  }

  if (membership.customRoleId) {
    return new Set(
      membership.customRole?.rolePermissions.map(
        (entry) => entry.permission.name
      ) ?? []
    );
  }

  if (membership.role === "manager") return new Set(MANAGER_PERMISSIONS);
  if (membership.role === "staff") return new Set(STAFF_PERMISSIONS);
  return new Set();
}

export function hasPermission(
  membership: PermissionMembership,
  permission: PermissionName
): boolean {
  return effectivePermissions(membership).has(permission);
}
