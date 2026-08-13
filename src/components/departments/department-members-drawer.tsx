"use client";

/**
 * Who works in one department.
 *
 * ## Read-only, on purpose
 *
 * Department assignment is written from the member drawer. A second writer for
 * the same relationship is how two screens come to disagree about it, so this
 * one shows and links rather than edits.
 *
 * ## Why deactivated members are listed rather than filtered
 *
 * The card that opens this drawer counts every department membership row,
 * deactivated ones included. Filtering here would put "8 members" above a list
 * of six, with nothing to tell the reader which number was wrong. They are
 * listed and marked, and the header states both figures — because "how many are
 * in this department" and "how many can be rostered" are different questions
 * and the card only ever answered the first.
 */
import { useCallback, useEffect, useState } from "react";
import { UserRound, UserX, X } from "lucide-react";

import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { PageLoading } from "@/components/ui/page-loading";
import { getSystemRoleLabel } from "@/lib/role-config";

interface DepartmentMember {
  id: string;
  role: string;
  status: string;
  employmentType: string | null;
  customRole: { id: string; name: string } | null;
  user: { id: string; name: string | null; email: string; image: string | null };
}

interface MembersResponse {
  department: { id: string; name: string };
  members: DepartmentMember[];
  total: number;
  active: number;
}

export function DepartmentMembersDrawer({
  orgId,
  departmentId,
  departmentName,
  onClose,
}: {
  orgId: string;
  departmentId: string;
  departmentName: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<MembersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/organizations/${orgId}/departments/${departmentId}/members`
      );
      if (!response.ok) {
        // An empty department and a failed load must not look the same.
        setError("Could not load the people in this department.");
        setData(null);
        return;
      }
      setError(null);
      setData(await response.json());
    } catch {
      setError("Could not reach the server.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [orgId, departmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Escape closes. A panel that covers what it came from and can only be
  // dismissed by aiming at a small button is a trap on a phone.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <button
        type="button"
        aria-label={`Close ${departmentName}`}
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-black/20 dark:bg-black/40"
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`People in ${departmentName}`}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-background shadow-xl sm:max-w-sm"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold">{departmentName}</h2>
            {data && (
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                {data.total} {data.total === 1 ? "person" : "people"}
                {data.active !== data.total && ` · ${data.active} active`}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {error && <AlertBanner variant="error" message={error} />}

          {loading ? (
            <PageLoading label="Loading people…" />
          ) : !error && data && data.members.length === 0 ? (
            <EmptyState
              icon={UserRound}
              title="Nobody is in this department yet"
              description="People are added to a department from their own record on the Members page."
            />
          ) : (
            <ul className="space-y-2">
              {data?.members.map((member) => {
                const inactive = member.status !== "active";
                const name = member.user.name ?? member.user.email;
                return (
                  <li
                    key={member.id}
                    className={`flex items-start gap-3 rounded-lg border border-border p-3 ${
                      inactive ? "bg-muted/40" : "bg-card"
                    }`}
                  >
                    <div
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                        inactive
                          ? "bg-muted text-muted-foreground"
                          : "bg-primary/10 text-primary"
                      }`}
                    >
                      {name.charAt(0).toUpperCase()}
                    </div>

                    <div className="min-w-0 flex-1">
                      <p
                        className={`truncate text-sm font-medium ${
                          inactive ? "text-muted-foreground" : ""
                        }`}
                      >
                        {name}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">
                          {getSystemRoleLabel(member.role, member.employmentType)}
                        </span>
                        {member.customRole && (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                            {member.customRole.name}
                          </span>
                        )}
                        {inactive && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                            <UserX className="h-3 w-3" aria-hidden="true" />
                            Deactivated
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="border-t border-border px-4 py-3">
          <a
            href={`/org/${orgId}/members`}
            className="text-[13px] font-medium text-primary hover:underline"
          >
            Add or remove people on the Members page
          </a>
        </footer>
      </aside>
    </>
  );
}
