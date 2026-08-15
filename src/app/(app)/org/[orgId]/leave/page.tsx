/**
 * Leave Requests Page (Boundary Layer)
 *
 * The register: every request that went through review, filtered by status,
 * department, date and person.
 *
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
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">
          Leave requests
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
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
