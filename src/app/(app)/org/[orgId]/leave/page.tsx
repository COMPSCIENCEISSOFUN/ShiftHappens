/**
 * Leave Requests Page (Boundary Layer)
 *
 * The register: every request that went through review, filtered by status,
 * department, date and person.
 *
 * ## Why this stopped being a queue
 *
 * It listed only what was awaiting a decision. That made it useful for exactly
 * one question — what do I owe an answer on — and unable to answer the one
 * everybody asked next: was Sam's July leave approved, and by whom. Once a
 * request was decided it existed only in the audit log, alongside role changes
 * and certification verdicts, which is not where anybody looks for a rota
 * question.
 *
 * The filters are the reason the change is worth making rather than a garnish
 * on it. A list of every request an organisation has ever made is unusable
 * without them, and a list of only the open ones needs none — so "add filters"
 * and "show history" are the same piece of work.
 *
 * ## Every filter is a server round trip
 *
 * Nothing is filtered in the browser. The register is paged, so filtering the
 * loaded rows would mean "filter the first fifty" while the count beside it
 * described something else. The department filter in particular is resolved in
 * the service, where it is INTERSECTED with the reader's own scope rather than
 * replacing it — the shape the 2026-08-05 audit was about.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Lock } from "lucide-react";
import { LeaveRegister } from "@/components/leave/leave-register";
import { EmptyState } from "@/components/ui/empty-state";
import { usePermissions } from "@/components/layout/permission-provider";

interface Department {
  id: string;
  name: string;
  color: string | null;
}

export default function LeaveRequestsPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const { can } = usePermissions();
  const mayReview = can("members:request_availability");

  const [departments, setDepartments] = useState<Department[]>([]);

  /*
   * The department list comes from the departments endpoint, which is already
   * scoped to the caller — a manager gets their own, an admin gets all. Nothing
   * here decides who may see what; if it did, that would be a second opinion
   * about scope, and the register's own filter would still have to agree with
   * it.
   */
  const loadDepartments = useCallback(async () => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/departments`);
      const body = await res.json();
      // Same shape trap as everywhere else: an error body is not an array, and
      // mapping it throws into a catch that then looks like an empty org.
      setDepartments(res.ok && Array.isArray(body) ? body : []);
    } catch {
      setDepartments([]);
    }
  }, [orgId]);

  useEffect(() => {
    if (!mayReview) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system: loads the department options for the filter
    loadDepartments();
  }, [mayReview, loadDepartments]);

  /*
   * The page answers rather than 404s for somebody without the permission. The
   * nav item is hidden from them, so arriving here means a typed URL or a
   * shared link — and the honest answer to that is "not yours", not a lie about
   * the page existing. The API refuses them regardless.
   */
  if (!mayReview) {
    return (
      <div className="w-full">
        <EmptyState
          icon={Lock}
          title="Not available to you"
          description="Only people who can review availability see leave requests."
        />
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="mb-4">
        <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
          Leave requests
        </h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Full-time staff stay on the roster until you approve. Nothing here
          changes anyone&apos;s schedule on its own.
        </p>
      </div>

      <LeaveRegister
        orgId={orgId}
        departments={departments}
        canReview={mayReview}
      />
    </div>
  );
}
