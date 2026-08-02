# Authorization Model

ShiftHappens authorization combines five checks. Passing one check never bypasses the others.

1. **Authentication** confirms the caller has a valid user session.
2. **Organization membership** confirms an active membership in the requested tenant.
3. **Permission** controls access to an operational capability.
4. **Department scope** limits Managers and Staff to records in their assigned departments.
5. **Record ownership** protects personal actions such as availability, notifications, certification submissions, and assignment time tracking.

## Effective Permissions

- Company Admin has every supported permission and cannot be restricted by a custom role.
- A Manager or Staff member without a custom role receives the application's system-role defaults.
- Assigning a custom role replaces the member's operational permission set with that role's explicit grants.
- Removing the custom role restores the system-role defaults.
- A missing or incompletely loaded assigned custom role fails closed with no operational permissions.

The shared resolver is `src/lib/permission-guard.ts`. Operational API routes call it before validation or service execution. Services continue to enforce tenant identifiers, department scopes, entity relationships, and ownership constraints.

## Personal Actions

Custom roles do not transfer ownership and do not remove access to a member's own records. A member may still use personal notification, availability, certification-submission, assignment clock, completion, and withdrawal routes when the route's ownership and lifecycle checks pass.

## Scope Rules

- A permission grant never permits cross-organization access.
- A Manager or Staff grant never expands their assigned department scope.
- Direct requests for out-of-scope records return the route's existing forbidden or not-found response.
- Subscription and suspended-organization gates remain effective after permission checks.

## Permission Data

Permissions are global named capabilities. Custom roles belong to one organization and connect to permissions through `RolePermission`. Memberships reference an optional custom role from the same organization. Run `npx prisma db seed` after deployment to upsert newly introduced permission keys.
