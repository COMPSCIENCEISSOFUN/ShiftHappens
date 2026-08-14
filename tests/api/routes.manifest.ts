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
 *   ADMIN      — company_admin only
 *   MANAGER    — company_admin or manager
 *   MEMBER     — any active membership, no role restriction
 *   ROSTERABLE — staff or manager, and NOT company_admin
 *
 * ROSTERABLE is the one that does not fit the ladder. The other three widen as
 * you go down it, so "is this role at least X" answers every one of them.
 * Rostering is not a level of authority — an admin outranks a manager and is
 * still excluded, because the question is whether the engine will ever put this
 * person on a shift. `canBeRostered` in src/lib/role-config.ts is the same
 * predicate the eligibility engine and the sidebar use.
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
/**
 * Staff and managers, excluding admins. Mirrors ROSTERABLE_ROLES.
 *
 * Not imported from src/lib/role-config so the manifest states the contract
 * rather than restating the implementation — a change to the roster rule should
 * make this file fail, not follow along silently.
 */
export const ROSTERABLE = ["staff", "manager"] as const;

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
  // Deliberately MEMBER where its parent is ADMIN. The calendar draws its grid
  // from the operating hours and is rendered for managers and staff, who were
  // getting a 403 from the admin-only read and silently falling back to
  // hard-coded defaults — so admins and their teams saw different calendars.
  // The route returns operating hours and nothing else; the narrow shape is
  // what makes the wider audience safe, and is asserted in
  // settings.service.test.ts.
  org("settings/display", "GET", MEMBER),
  org("subscription", "GET", MEMBER),
  org("checkout", "POST", ADMIN),
  /*
   * Applies the tier for a checkout the browser has just returned from, when
   * the webhook has not arrived — always the case on localhost. `billing:manage`,
   * the same as starting the checkout: whoever could begin the purchase can
   * finish it. Passing a session id asserts nothing, since the service reads
   * the session back from Stripe and refuses one that is unpaid or another
   * organisation's.
   */
  org("checkout/reconcile", "POST", ADMIN),
  /*
   * Buying permanent project quota. `billing:manage` rather than a projects
   * permission: this spends money, and whoever may create a project is not
   * necessarily whoever may commit the organisation to paying for one.
   */
  org("projects/slots", "POST", ADMIN, { suspension: true }),
  /*
   * `billing:manage` rather than a role list. Usage is separately readable by
   * any member through `subscription` above — what this gates is the money.
   */
  org("billing", "GET", ADMIN),
  org("billing/portal", "POST", ADMIN, { suspension: true }),
  org("billing/cancel", "POST", ADMIN, { suspension: true }),
  org("billing/cancel", "DELETE", ADMIN, { suspension: true }),
  org("billing/change-plan", "POST", ADMIN, { suspension: true }),
  org("invitations", "GET", ADMIN),
  org("invitations", "POST", ADMIN, { suspension: true }),
  /*
   * Revoking, and the two halves of a bulk invite.
   *
   * All three carry `members:invite`, the same permission as sending one:
   * anybody who could issue an invitation can withdraw it or send forty, and
   * nobody else needs to. `import` reads nothing and writes nothing — it
   * resolves a spreadsheet into a preview — but it is gated identically
   * because it forwards its input to a model, and an ungated endpoint that
   * spends AI credits is its own problem.
   */
  org("invitations/[invitationId]", "DELETE", ADMIN, {
    suspension: true,
    extraParams: ["invitationId"],
  }),
  org("invitations/import", "POST", ADMIN, { suspension: true }),
  org("invitations/bulk", "POST", ADMIN, { suspension: true }),
  /*
   * MANAGER, not MEMBER. These four reference lists required only membership,
   * so any staff member who typed the URL got the org's whole task board,
   * member directory (names, emails, roles), department list and custom-role
   * map — while the sidebar hid every one of those links. The menu was right.
   * The permission sets are `*_LIST_READERS` in src/lib/permissions.ts, each
   * naming the screens that consume the endpoint.
   */
  org("members", "GET", MANAGER),
  org("members/[userId]", "PATCH", ADMIN, { suspension: true, extraParams: ["userId"] }),
  org("members/[userId]/toggle-status", "POST", ADMIN, { suspension: true, extraParams: ["userId"] }),
  /*
   * The shifts a member is still expected to work, read by the deactivation
   * confirmation so an admin sees what they are about to leave short.
   *
   * Gated on `members:deactivate` rather than on reading members: this answers
   * "what does deactivating this person cost", and it is only ever asked by
   * somebody about to do it.
   */
  org("members/[userId]/upcoming-commitments", "GET", ADMIN, {
    extraParams: ["userId"],
  }),
  // MANAGER where its siblings are ADMIN, deliberately. Seniority is a
  // rostering judgement rather than an administrative one, and a manager
  // blocked by a composition rule they cannot resolve will delete the rule.
  org("members/seniority", "GET", MANAGER),
  org("members/[userId]/seniority", "PATCH", MANAGER, { suspension: true, extraParams: ["userId"] }),
  // A nudge rather than an edit: it asks a CASUAL member to go and set their
  // own availability, which is still theirs to set. Writing somebody's pattern
  // outright is contracted-days below, and admin.
  org("members/[userId]/request-availability", "POST", MANAGER, {
    suspension: true,
    extraParams: ["userId"],
  }),
  // ADMIN, unlike seniority above. What days somebody is employed to work is a
  // term of employment, not a rostering call.
  org("members/[userId]/contracted-days", "GET", ADMIN, { extraParams: ["userId"] }),
  org("members/[userId]/contracted-days", "PUT", ADMIN, {
    suspension: true,
    extraParams: ["userId"],
  }),
  org("members/import", "POST", ADMIN, { suspension: true }),

  // ── Departments ─────────────────────────────────────────────────────
  org("departments", "GET", MANAGER),
  org("departments", "POST", ADMIN, { suspension: true }),
  org("departments/[deptId]", "GET", ADMIN, { extraParams: ["deptId"] }),
  org("departments/[deptId]", "PATCH", ADMIN, { suspension: true, extraParams: ["deptId"] }),
  org("departments/[deptId]", "DELETE", ADMIN, { suspension: true, extraParams: ["deptId"] }),
  /*
   * MANAGER, matching the department LIST rather than the admin-only detail
   * route it sits under: who works in a department is a rostering question.
   */
  org("departments/[deptId]/members", "GET", MANAGER, { extraParams: ["deptId"] }),

  // ── Roles ───────────────────────────────────────────────────────────
  org("roles", "GET", MANAGER),
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
  org("tasks", "GET", MANAGER),
  org("tasks", "POST", MANAGER, { suspension: true }),
  org("tasks/[taskId]", "GET", MEMBER, { extraParams: ["taskId"] }),
  org("tasks/[taskId]", "PATCH", MANAGER, { suspension: true, extraParams: ["taskId"] }),
  org("tasks/[taskId]", "DELETE", MANAGER, { suspension: true, extraParams: ["taskId"] }),

  /*
   * Projects group work items; they do not introduce a permission of their
   * own. The routes reuse the task vocabulary deliberately — whoever may
   * build a roster may group it — so a change to who reads the task board
   * moves these with it instead of leaving a second answer behind.
   */
  org("projects", "GET", MANAGER),
  org("projects", "POST", MANAGER, { suspension: true }),
  org("projects/[projectId]", "GET", MANAGER, { extraParams: ["projectId"] }),
  org("projects/[projectId]", "PATCH", MANAGER, { suspension: true, extraParams: ["projectId"] }),
  /*
   * `tasks:delete`, not the `tasks:update` PATCH carries. Renaming a project
   * and dissolving one are different acts, and somebody trusted to keep a
   * project's details current is not automatically trusted to remove it.
   */
  org("projects/[projectId]", "DELETE", MANAGER, {
    suspension: true,
    extraParams: ["projectId"],
  }),
  org("projects/[projectId]/team", "GET", MANAGER, { extraParams: ["projectId"] }),
  org("projects/[projectId]/team", "PUT", MANAGER, { suspension: true, extraParams: ["projectId"] }),

  /*
   * MEMBER, and gated by nothing else.
   *
   * Every member may say what they think of the product. A permission here
   * would let an organisation configure some of its own people out of being
   * heard, and a plan tier would be selling the tenant a feature whose
   * beneficiary is us. Rate limiting does the work a gate would.
   */
  org("feedback", "POST", MEMBER, { suspension: false }),
  /* Same reasoning as feedback: every member may have an opinion. */
  org("reviews", "GET", MEMBER),
  org("reviews", "POST", MEMBER, { suspension: false }),
  org("tasks/[taskId]/assign", "POST", MANAGER, { suspension: true, extraParams: ["taskId"] }),
  org("tasks/[taskId]/auto-allocate", "POST", MANAGER, { suspension: true, extraParams: ["taskId"] }),
  org("tasks/[taskId]/composition", "GET", MANAGER, { extraParams: ["taskId"] }),
  /*
   * MANAGER, and gated on `tasks:assign` rather than
   * `allocation:use_suggestions` — see the route header. Deciding a withdrawal
   * request is a rostering act, not an AI feature, and an organisation that has
   * withheld AI suggestions has not said its managers should answer those
   * requests without knowing whether cover exists.
   */
  org("tasks/[taskId]/cover-options", "GET", MANAGER, { extraParams: ["taskId"] }),
  org("tasks/[taskId]/eligibility", "GET", MANAGER, { extraParams: ["taskId"] }),
  org("tasks/[taskId]/pending-leave", "GET", MANAGER, { extraParams: ["taskId"] }),
  org("tasks/[taskId]/eligibility/override", "POST", MANAGER, { suspension: true, extraParams: ["taskId"] }),
  org("tasks/[taskId]/suggest", "GET", MANAGER, { extraParams: ["taskId"] }),
  org("tasks/assignments/[assignmentId]", "DELETE", MANAGER, { suspension: true, extraParams: ["assignmentId"] }),
  /*
   * MANAGER, and a DIFFERENT permission from its DELETE sibling.
   * `assignments:correct_clock` rewrites the record of what already happened,
   * on the field the hours totals are built from — a separate authority from
   * rostering, which is why it is a separate route rather than a method on the
   * file next door.
   */
  org("tasks/assignments/[assignmentId]/clock", "PATCH", MANAGER, {
    suspension: true,
    extraParams: ["assignmentId"],
  }),
  org("tasks/parse", "POST", MANAGER, { suspension: true }),
  org("recurring-tasks/generate", "POST", MANAGER, { suspension: true }),

  // ── Scheduling & availability ───────────────────────────────────────
  org("auto-schedule", "POST", ADMIN, { suspension: true }),
  org("auto-schedule/confirm", "POST", ADMIN, { suspension: true }),
  org("availability", "GET", MEMBER),
  org("availability", "PUT", MEMBER, { suspension: true }),
  org("availability/overrides", "GET", MEMBER),
  org("availability/overrides", "POST", MEMBER, { suspension: true }),
  org("availability/overrides/[overrideId]", "DELETE", MEMBER, {
    suspension: true,
    extraParams: ["overrideId"],
  }),
  org("leave", "GET", MANAGER),
  org("leave/[overrideId]", "PATCH", MANAGER, {
    suspension: true,
    extraParams: ["overrideId"],
  }),
  org("leave/dismiss-lapsed", "POST", MANAGER, { suspension: true }),
  org("calendar/coverage", "GET", MANAGER),
  /*
   * No permission and no plan gate. A feed is your own shifts, so the
   * membership IS the authorisation — and the plan is checked on the FEED,
   * which is polled long after anybody visits this page.
   */
  org("calendar/feed", "GET", MEMBER),
  org("calendar/feed", "POST", MEMBER, { suspension: true }),
  org("calendar/staff", "GET", MANAGER),

  // ── Certifications ──────────────────────────────────────────────────
  org("certifications", "GET", MANAGER),
  org("certifications", "POST", MEMBER, { suspension: true }),
  org("certifications/[certId]", "GET", MEMBER, { extraParams: ["certId"] }),
  org("certifications/[certId]", "PATCH", MANAGER, { suspension: true, extraParams: ["certId"] }),
  org("certifications/[certId]", "POST", MANAGER, { suspension: true, extraParams: ["certId"] }),
  org("certifications/[certId]", "DELETE", MEMBER, { suspension: true, extraParams: ["certId"] }),
  org("my-certifications", "GET", MEMBER),
  /*
   * The organisation's list of recognised certificates.
   *
   * GET is MEMBER on purpose. A staff member recording a certificate of their
   * own is shown this list as suggestions, so gating the read on
   * `certifications:review` would hide it from half the people it exists to
   * keep in agreement.
   */
  org("certification-types", "GET", MEMBER),
  org("certification-types", "POST", MANAGER, { suspension: true }),
  org("certification-types/[typeId]", "DELETE", MANAGER, {
    suspension: true,
    extraParams: ["typeId"],
  }),

  // ── Personal views ──────────────────────────────────────────────────
  org("my-tasks", "GET", MEMBER),
  /*
   * ROSTERABLE, not MEMBER. An admin's history is permanently empty — they are
   * excluded from the eligibility engine, from assignStaff and from
   * findSchedulableStaff — and an empty page saying "you have worked no shifts"
   * gives the wrong reason for it.
   */
  org("my-history", "GET", ROSTERABLE),
  org("notifications", "GET", MEMBER),
  org("notifications/[id]/read", "PATCH", MEMBER, { extraParams: ["id"] }),
  org("notifications/mark-all-read", "POST", MEMBER),
  org("notifications/unread-count", "GET", MEMBER),

  // ── Reporting & insight ─────────────────────────────────────────────
  org("dashboard", "GET", MEMBER),
  org("dashboard/ai-recommendations", "GET", MANAGER),
  org("hour-alerts", "GET", MANAGER),
  org("hour-alerts", "POST", MANAGER, { suspension: true }),
  org("reports", "GET", MANAGER),
  org("reports/engine", "GET", MANAGER),
  org("reports/export", "GET", MANAGER, { suspension: true }),
  /*
   * MANAGER, because `assistant:use` is in the manager bundle and admins hold
   * everything. Staff reach it only through a custom role — the same shape as
   * every other manager route here, and the reason the sweep asserts a plain
   * staff member is refused.
   *
   * No `suspension: true`. It reads and changes nothing, so a suspended
   * organisation being able to ask what its rota looks like is correct: the
   * suspension stops work being done, not questions being asked. The
   * dashboard, which answers the same questions on a page, is unsuspended for
   * the same reason.
   */
  org("assistant", "POST", MANAGER),

  // ── Assignment actions ──────────────────────────────────────────────
  // This group takes orgId from the QUERY STRING, not the path. Without it they
  // return 400 "orgId required" before the membership check — so a sweep that
  // omitted it would misread seven routes as passing.
  ...(["accept", "clock-in", "complete", "rate", "reject", "withdraw"] as const).map(
    (action): RouteSpec => ({
      path: `assignments/[assignmentId]/${action}`,
      method: "POST",
      auth: "session",
      roles: MEMBER,
      orgScoped: true,
      orgIdInQuery: true,
      suspension: true,
      extraParams: ["assignmentId"],
    })
  ),
  {
    // clock-out is the ONLY assignment action that does not refuse a suspended
    // org, and the exemption is deliberate. It is the one action that merely
    // ENDS work already under way: a member can only reach it once clocked in,
    // and refusing it would strand them mid-shift with the hours they actually
    // worked never written down. Suspension still bites — `complete` is
    // guarded, so the assignment stops at "clocked_out" until reactivation.
    path: "assignments/[assignmentId]/clock-out",
    method: "POST",
    auth: "session",
    roles: MEMBER,
    orgScoped: true,
    orgIdInQuery: true,
    extraParams: ["assignmentId"],
    note: "Deliberately exempt from the suspension gate — see comment above.",
  },
  {
    path: "assignments/[assignmentId]/withdrawal",
    method: "POST",
    auth: "session",
    roles: MANAGER,
    orgScoped: true,
    orgIdInQuery: true,
    suspension: true,
    extraParams: ["assignmentId"],
  },
  {
    path: "assignments/[assignmentId]/decline",
    method: "POST",
    auth: "session",
    roles: MANAGER,
    orgScoped: true,
    orgIdInQuery: true,
    suspension: true,
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
  { path: "platform/templates", method: "GET", auth: "session" },
  { path: "platform/templates", method: "POST", auth: "session" },
  { path: "platform/templates/[templateId]", method: "GET", auth: "session", extraParams: ["templateId"] },
  { path: "platform/templates/[templateId]", method: "PATCH", auth: "session", extraParams: ["templateId"] },
  { path: "platform/templates/[templateId]", method: "DELETE", auth: "session", extraParams: ["templateId"] },
  { path: "platform/feedback", method: "GET", auth: "platform" },
  { path: "platform/feedback/[feedbackId]", method: "PATCH", auth: "platform", extraParams: ["feedbackId"] },
  { path: "platform/faq", method: "GET", auth: "platform" },
  { path: "platform/faq", method: "POST", auth: "platform" },
  { path: "platform/faq/[faqId]", method: "PATCH", auth: "platform", extraParams: ["faqId"] },
  { path: "platform/faq/[faqId]", method: "DELETE", auth: "platform", extraParams: ["faqId"] },
  { path: "platform/questions", method: "GET", auth: "platform" },
  { path: "platform/questions/[questionId]", method: "PATCH", auth: "platform", extraParams: ["questionId"] },
  { path: "platform/reviews", method: "GET", auth: "platform" },
  { path: "platform/reviews/[reviewId]", method: "PATCH", auth: "platform", extraParams: ["reviewId"] },

  /*
   * The member-facing half of what `platform/templates` GET used to serve.
   *
   * Session only, and deliberately NO membership requirement: a user
   * mid-onboarding has no organisation yet, and this is the list they choose
   * one from. It returns active templates and nothing else — the usage counts
   * stayed behind the platform guard, being a cross-tenant aggregate.
   */
  { path: "industry-templates", method: "GET", auth: "session" },

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
  /*
   * The token in the path IS the credential. Calendar clients send no cookie,
   * no session and no header, and there is no step in which one could be
   * supplied — so this is listed as secret-authenticated rather than public,
   * because it is neither open nor session-guarded.
   */
  {
    path: "calendar/[token]",
    method: "GET",
    auth: "secret",
    extraParams: ["token"],
    note: "the token in the URL is the credential",
  },
  { path: "cron", method: "GET", auth: "secret", note: "Authorization: Bearer CRON_SECRET" },
  { path: "stripe/webhook", method: "POST", auth: "secret", note: "stripe-signature header" },
  /*
   * The only unauthenticated WRITE in the application.
   *
   * Everything else marked public is a read. This one exists because the FAQ
   * is written for people who have not signed up, and the only way to know
   * what they want to know is to let them say it. Bounded by an address-keyed
   * rate limit and a honeypot rather than by a session, and nothing it stores
   * is ever rendered to another visitor.
   */
  {
    path: "questions",
    method: "POST",
    auth: "public",
    note: "landing page contact form; rate limited by address",
  },
];

/** Every distinct route file path the manifest declares. */
export const DECLARED_PATHS = new Set(ROUTES.map((r) => r.path));

/** Entries whose gates the contract sweep can drive. */
export const SESSION_ROUTES = ROUTES.filter((r) => r.auth === "session");
export const ORG_ROUTES = SESSION_ROUTES.filter((r) => r.orgScoped);
/**
 * Routes that refuse a plain staff member.
 *
 * Excludes ROSTERABLE routes, which name two roles and allow staff — running
 * them through the "403 for staff" sweep would assert the opposite of their
 * contract. They have their own sweep below.
 */
export const ROLE_GATED_ROUTES = ORG_ROUTES.filter(
  (r) =>
    Array.isArray(r.roles) &&
    r.roles.length > 0 &&
    !r.roles.includes("staff")
);

/** Routes open to anyone who can be put on a shift, and closed to admins. */
export const ROSTERABLE_ROUTES = ORG_ROUTES.filter(
  (r) => Array.isArray(r.roles) && r.roles.includes("staff") && !r.roles.includes("company_admin")
);
export const SUSPENSION_ROUTES = ORG_ROUTES.filter((r) => r.suspension);
