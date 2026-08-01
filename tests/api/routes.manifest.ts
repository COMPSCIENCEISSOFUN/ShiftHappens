/**
 * The declared contract of the Boundary layer.
 *
 * One entry per (route, method) pair, stating what that endpoint promises about
 * authentication, role and organisation suspension. `contract.test.ts` drives
 * every entry; `manifest-completeness.test.ts` fails the suite if a route file
 * exists that is not declared here.
 *
 * That pairing is what makes this durable rather than a table that rots. A new
 * route cannot be merged without a decision about who may call it, and the
 * decision is recorded here in a form a machine checks.
 *
 * It also serves as the BCE traceability artefact for the Boundary layer: a
 * complete, verified statement of the access rules, rather than a diagram that
 * drifts from the code.
 *
 * ROLE VOCABULARY
 *   ADMIN    — company_admin only
 *   MANAGER  — company_admin or manager
 *   MEMBER   — any active membership, no role restriction
 */

export type AuthMode =
  /** getAuthenticatedUser() → 401 when anonymous */
  | "session"
  /** getPlatformAdmin() → 403 when anonymous (deliberately not 401) */
  | "platform"
  /** no session required by design */
  | "public"
  /** bearer secret or webhook signature, not a user session */
  | "secret";

export const ADMIN = ["company_admin"] as const;
export const MANAGER = ["company_admin", "manager"] as const;
export const MEMBER = null;

export interface RouteSpec {
  /** Path relative to src/app/api, without the trailing /route.ts */
  path: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  auth: AuthMode;
  /** Allowed roles, or MEMBER (null) when any active membership may call it. */
  roles?: readonly string[] | null;
  /** True when the handler calls checkOrgSuspended / checkOrgActive. */
  suspension?: boolean;
  /** True when the route is scoped to an org via the [orgId] path param. */
  orgScoped?: boolean;
  /** The assignments group reads orgId from the query string, not the path. */
  orgIdInQuery?: boolean;
  /** Extra path params beyond orgId; filled with placeholders by the harness. */
  extraParams?: readonly string[];
  /** Documented reason this entry is exempt from part of the contract sweep. */
  note?: string;
}

const org = (
  path: string,
  method: RouteSpec["method"],
  roles: readonly string[] | null,
  opts: Partial<RouteSpec> = {}
): RouteSpec => ({
  path: `organizations/[orgId]/${path}`.replace(/\/$/, ""),
  method,
  auth: "session",
  roles,
  orgScoped: true,
  ...opts,
});

export const ROUTES: RouteSpec[] = [
  // ── Organisation root ───────────────────────────────────────────────
  org("", "GET", MEMBER),
  org("", "PATCH", ADMIN, { suspension: true }),

  // ── Admin-only administration ───────────────────────────────────────
  org("audit-logs", "GET", ADMIN),
  org("permissions", "GET", ADMIN),
  org("settings", "GET", ADMIN),
  org("settings", "PATCH", ADMIN, { suspension: true }),
  org("subscription", "GET", MEMBER),
  org("checkout", "POST", ADMIN),
  org("invitations", "GET", ADMIN),
  org("invitations", "POST", ADMIN, { suspension: true }),
  org("members", "GET", MEMBER),
  org("members/[userId]", "PATCH", ADMIN, { suspension: true, extraParams: ["userId"] }),
  org("members/[userId]/toggle-status", "POST", ADMIN, { suspension: true, extraParams: ["userId"] }),
  org("members/import", "POST", ADMIN, { suspension: true }),

  // ── Departments ─────────────────────────────────────────────────────
  org("departments", "GET", MEMBER),
  org("departments", "POST", ADMIN, { suspension: true }),
  org("departments/[deptId]", "GET", ADMIN, { extraParams: ["deptId"] }),
  org("departments/[deptId]", "PATCH", ADMIN, { suspension: true, extraParams: ["deptId"] }),
  org("departments/[deptId]", "DELETE", ADMIN, { suspension: true, extraParams: ["deptId"] }),

  // ── Roles ───────────────────────────────────────────────────────────
  org("roles", "GET", MEMBER),
  org("roles", "POST", ADMIN, { suspension: true }),
  org("roles/[roleId]", "GET", MEMBER, { extraParams: ["roleId"] }),
  org("roles/[roleId]", "PATCH", ADMIN, { suspension: true, extraParams: ["roleId"] }),
  org("roles/[roleId]", "DELETE", ADMIN, { suspension: true, extraParams: ["roleId"] }),

  // ── Work rules ──────────────────────────────────────────────────────
  org("work-rules", "GET", ADMIN),
  org("work-rules", "POST", ADMIN, { suspension: true }),
  org("work-rules/[ruleId]", "PATCH", ADMIN, { suspension: true, extraParams: ["ruleId"] }),
  org("work-rules/[ruleId]", "DELETE", ADMIN, { suspension: true, extraParams: ["ruleId"] }),

  // ── Tasks ───────────────────────────────────────────────────────────
  org("tasks", "GET", MEMBER),
  org("tasks", "POST", MANAGER, { suspension: true }),
  org("tasks/[taskId]", "GET", MEMBER, { extraParams: ["taskId"] }),
  org("tasks/[taskId]", "PATCH", MANAGER, { suspension: true, extraParams: ["taskId"] }),
  org("tasks/[taskId]", "DELETE", MANAGER, { suspension: true, extraParams: ["taskId"] }),
  org("tasks/[taskId]/assign", "POST", MANAGER, { suspension: true, extraParams: ["taskId"] }),
  org("tasks/[taskId]/auto-allocate", "POST", MANAGER, { extraParams: ["taskId"] }),
  org("tasks/[taskId]/eligibility", "GET", MANAGER, { extraParams: ["taskId"] }),
  org("tasks/[taskId]/eligibility/override", "POST", MANAGER, { extraParams: ["taskId"] }),
  org("tasks/[taskId]/suggest", "GET", MANAGER, { extraParams: ["taskId"] }),
  org("tasks/assignments/[assignmentId]", "DELETE", MANAGER, { extraParams: ["assignmentId"] }),
  org("tasks/parse", "POST", MANAGER),
  org("recurring-tasks/generate", "POST", MANAGER),

  // ── Scheduling & availability ───────────────────────────────────────
  org("auto-schedule", "POST", ADMIN, { suspension: true }),
  org("auto-schedule/confirm", "POST", ADMIN, { suspension: true }),
  org("availability", "GET", MEMBER),
  org("availability", "PUT", MEMBER),
  org("availability/overrides", "GET", MEMBER),
  org("availability/overrides", "POST", MEMBER),
  org("calendar/coverage", "GET", MANAGER),
  org("calendar/staff", "GET", MANAGER),

  // ── Certifications ──────────────────────────────────────────────────
  org("certifications", "GET", MANAGER),
  org("certifications", "POST", MEMBER),
  org("certifications/[certId]", "GET", MEMBER, { extraParams: ["certId"] }),
  org("certifications/[certId]", "PATCH", MANAGER, { extraParams: ["certId"] }),
  org("certifications/[certId]", "POST", MANAGER, { extraParams: ["certId"] }),
  org("certifications/[certId]", "DELETE", MEMBER, { extraParams: ["certId"] }),
  org("my-certifications", "GET", MEMBER),

  // ── Personal views ──────────────────────────────────────────────────
  org("my-tasks", "GET", MEMBER),
  org("notifications", "GET", MEMBER),
  org("notifications/[id]/read", "PATCH", MEMBER, { extraParams: ["id"] }),
  org("notifications/mark-all-read", "POST", MEMBER),
  org("notifications/unread-count", "GET", MEMBER),

  // ── Reporting & insight ─────────────────────────────────────────────
  org("dashboard", "GET", MEMBER),
  org("dashboard/ai-recommendations", "GET", MANAGER),
  org("dashboard-insights", "GET", MANAGER),
  org("hour-alerts", "GET", MANAGER),
  org("hour-alerts", "POST", MANAGER),
  org("reports", "GET", MANAGER),
  org("reports/export", "GET", MANAGER, { suspension: true }),

  // ── Assignment actions ──────────────────────────────────────────────
  // This group takes orgId from the QUERY STRING, not the path. Without it they
  // return 400 "orgId required" before the membership check — so a sweep that
  // omitted it would misread seven routes as passing.
  ...(["clock-in", "clock-out", "complete", "withdraw"] as const).map(
    (action): RouteSpec => ({
      path: `assignments/[assignmentId]/${action}`,
      method: "POST",
      auth: "session",
      roles: MEMBER,
      orgScoped: true,
      orgIdInQuery: true,
      extraParams: ["assignmentId"],
    })
  ),
  {
    path: "assignments/[assignmentId]/withdrawal",
    method: "POST",
    auth: "session",
    roles: MANAGER,
    orgScoped: true,
    orgIdInQuery: true,
    extraParams: ["assignmentId"],
  },

  // ── Authenticated but not org-scoped ────────────────────────────────
  { path: "organizations", method: "GET", auth: "session" },
  { path: "organizations", method: "POST", auth: "session" },
  {
    path: "organizations/generate-template",
    method: "POST",
    auth: "session",
    note: "Any logged-in user; deliberately not org-scoped. Spends AI quota.",
  },
  { path: "profile", method: "GET", auth: "session" },
  { path: "profile", method: "PATCH", auth: "session" },

  // ── Platform admin ──────────────────────────────────────────────────
  // getPlatformAdmin() returns 403 for anonymous callers, not 401. Everything
  // else in the app returns 401. Recorded rather than "fixed" — changing it
  // would alter four live responses for no security gain.
  { path: "platform/stats", method: "GET", auth: "platform" },
  { path: "platform/organizations", method: "GET", auth: "platform" },
  { path: "platform/organizations/[orgId]", method: "GET", auth: "platform", extraParams: ["orgId"] },
  { path: "platform/organizations/[orgId]", method: "PATCH", auth: "platform", extraParams: ["orgId"] },
  {
    path: "platform/templates",
    method: "GET",
    auth: "session",
    note: "KNOWN GAP: the isPlatformAdmin lookup only branches the response, it never denies. Any authenticated user can list active templates. Sibling [templateId] GET does deny.",
  },
  { path: "platform/templates", method: "POST", auth: "session" },
  { path: "platform/templates/[templateId]", method: "GET", auth: "session", extraParams: ["templateId"] },
  { path: "platform/templates/[templateId]", method: "PATCH", auth: "session", extraParams: ["templateId"] },
  { path: "platform/templates/[templateId]", method: "DELETE", auth: "session", extraParams: ["templateId"] },

  // ── Public by design ────────────────────────────────────────────────
  { path: "register", method: "POST", auth: "public" },
  { path: "forgot-password", method: "POST", auth: "public" },
  { path: "reset-password", method: "POST", auth: "public" },
  { path: "verify-email", method: "POST", auth: "public" },
  { path: "invitations/[token]", method: "GET", auth: "public", extraParams: ["token"] },
  { path: "invitations/[token]", method: "POST", auth: "public", extraParams: ["token"] },
  { path: "auth/[...nextauth]", method: "GET", auth: "public", note: "NextAuth internals" },
  { path: "auth/[...nextauth]", method: "POST", auth: "public", note: "NextAuth internals" },

  // ── Secret-authenticated, not session ───────────────────────────────
  { path: "cron", method: "GET", auth: "secret", note: "Authorization: Bearer CRON_SECRET" },
  { path: "stripe/webhook", method: "POST", auth: "secret", note: "stripe-signature header" },
];

/** Every distinct route file path the manifest declares. */
export const DECLARED_PATHS = new Set(ROUTES.map((r) => r.path));

/** Entries whose gates the contract sweep can drive. */
export const SESSION_ROUTES = ROUTES.filter((r) => r.auth === "session");
export const ORG_ROUTES = SESSION_ROUTES.filter((r) => r.orgScoped);
export const ROLE_GATED_ROUTES = ORG_ROUTES.filter(
  (r) => Array.isArray(r.roles) && r.roles.length > 0
);
export const SUSPENSION_ROUTES = ORG_ROUTES.filter((r) => r.suspension);
