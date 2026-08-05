/**
 * The caller's effective permissions, available to any page under `(app)`.
 *
 * ## Why this exists
 *
 * The sidebar was aligned with permissions first, so a non-admin is no longer
 * LINKED to a page they cannot use. The pages themselves were never aligned at
 * all: the departments page, for one, carried zero role checks, so a manager
 * arriving by URL saw a "+ New Department" button, Edit, Archive and Delete on
 * every row — four actions that each returned 403 — plus org-wide counts they
 * are scoped out of everywhere else in the product.
 *
 * The permissions are resolved once, server-side, in the `(app)` layout, from
 * the same membership the route guard uses. Passing them down rather than
 * fetching them again means the menu, the page and the API cannot disagree
 * about who the caller is.
 *
 * ## What this is NOT
 *
 * Not a security boundary. Hiding a button stops a person pressing something
 * that will fail; it does not stop a request. Every action behind these checks
 * is independently enforced by `requirePermission` at its route, and that is
 * what actually refuses. This is about not offering what cannot be done.
 */
"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

interface PermissionContextValue {
  /** Does the caller hold this exact permission? */
  can: (permission: string) => boolean;
  /** Any one of these is enough — for pages several permissions can reach. */
  canAny: (...permissions: string[]) => boolean;
  /** The raw set, for callers that need to reason about it themselves. */
  permissions: ReadonlySet<string>;
}

/**
 * Default DENIES everything.
 *
 * A page rendered outside the provider — a test, a future layout — shows no
 * actions rather than all of them. The opposite default would turn a wiring
 * mistake into a screen full of buttons that 403.
 */
const PermissionContext = createContext<PermissionContextValue>({
  can: () => false,
  canAny: () => false,
  permissions: new Set(),
});

export function PermissionProvider({
  permissions,
  children,
}: {
  permissions: string[];
  children: ReactNode;
}) {
  /*
   * Keyed on the CONTENTS, not the array.
   *
   * The layout builds a fresh array on every render, so depending on the array
   * itself would rebuild the set — and re-render every consumer — each time.
   * Hoisted into its own variable because a dependency list has to be plain
   * identifiers; `permissions.join("|")` inline is a lint error, not a style
   * preference.
   */
  const key = permissions.join("|");
  const value = useMemo<PermissionContextValue>(() => {
    const held = new Set(key ? key.split("|") : []);
    return {
      can: (permission: string) => held.has(permission),
      canAny: (...candidates: string[]) => candidates.some((p) => held.has(p)),
      permissions: held,
    };
  }, [key]);

  return (
    <PermissionContext.Provider value={value}>
      {children}
    </PermissionContext.Provider>
  );
}

export function usePermissions() {
  return useContext(PermissionContext);
}
