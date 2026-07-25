/**
 * Certifications Management Page (Boundary Layer)
 * 
 * Admin/Manager view: lists all certifications across the org
 * with ability to verify or reject pending submissions.
 * Filterable by status and member name.
 */
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";

interface Certification {
  id: string;
  name: string;
  issuedDate: string;
  expiryDate: string | null;
  documentUrl: string | null;
  status: string;
  verifiedBy: { name: string | null } | null;
  verifiedAt: string | null;
  membership: {
    user: { id: string; name: string | null; email: string };
  };
}

export default function CertificationsPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const [certifications, setCertifications] = useState<Certification[]>([]);
  const [filterStatus, setFilterStatus] = useState("");
  const [filterName, setFilterName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchCertifications();
  }, [orgId, filterStatus]);

  async function fetchCertifications() {
    try {
      const params = new URLSearchParams();
      if (filterStatus) params.set("status", filterStatus);

      const res = await fetch(
        `/api/organizations/${orgId}/certifications?${params}`
      );
      const data = await res.json();
      setCertifications(data);
    } catch {
      setError("Failed to load certifications");
    } finally {
      setLoading(false);
    }
  }

  async function onVerify(certId: string, status: string) {
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/certifications/${certId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        }
      );

      if (!res.ok) {
        const result = await res.json();
        setError(result.error || "Failed to update certification");
        return;
      }

      setSuccess(`Certification ${status}`);
      fetchCertifications();
    } catch {
      setError("Something went wrong");
    }
  }

  // Filter by member name (client-side)
  const filtered = certifications.filter((cert) => {
    if (!filterName) return true;
    const name = cert.membership.user.name || cert.membership.user.email;
    return name.toLowerCase().includes(filterName.toLowerCase());
  });

  // Group by member
  const grouped: Record<string, Certification[]> = {};
  for (const cert of filtered) {
    const name = cert.membership.user.name || cert.membership.user.email;
    if (!grouped[name]) grouped[name] = [];
    grouped[name].push(cert);
  }

  if (loading) return <PageLoading />;

  const pendingCount = certifications.filter((c) => c.status === "pending").length;

  return (
    <div className="max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Certifications</h2>
          {pendingCount > 0 && (
            <p className="text-sm text-amber-600">
              {pendingCount} pending verification
            </p>
          )}
        </div>
      </div>

      {error && <AlertBanner message={error} variant="error" />}
      {success && <AlertBanner message={success} variant="success" />}

      {/* Filters */}
      <div className="mb-4 flex gap-4">
        <Input
          placeholder="Filter by member name..."
          value={filterName}
          onChange={(e) => setFilterName(e.target.value)}
          className="max-w-xs"
        />
        <select
          className="rounded-md border px-3 py-2 text-sm"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="verified">Verified</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {Object.keys(grouped).length === 0 ? (
        <EmptyState title="No certifications found" />
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([memberName, certs]) => (
            <div key={memberName}>
              <h3 className="mb-3 text-lg font-semibold">{memberName}</h3>
              <div className="space-y-3">
                {certs.map((cert) => (
                  <Card key={cert.id}>
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div>
                          <CardTitle className="flex items-center gap-2 text-base">
                            {cert.name}
                            <StatusBadge value={cert.status} palette="certification" />
                          </CardTitle>
                          <CardDescription>
                            Issued: {new Date(cert.issuedDate).toLocaleDateString()}
                            {cert.expiryDate && (
                              <>
                                {" · Expires: "}
                                <span
                                  className={
                                    new Date(cert.expiryDate) < new Date()
                                      ? "text-red-500 font-medium"
                                      : ""
                                  }
                                >
                                  {new Date(cert.expiryDate).toLocaleDateString()}
                                </span>
                              </>
                            )}
                          </CardDescription>
                        </div>
                        {cert.status === "pending" && (
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={() => onVerify(cert.id, "verified")}
                            >
                              Verify
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => onVerify(cert.id, "rejected")}
                            >
                              Reject
                            </Button>
                          </div>
                        )}
                      </div>
                    </CardHeader>
                    {cert.verifiedBy && (
                      <CardContent>
                        <p className="text-sm text-muted-foreground">
                          {cert.status === "verified" ? "Verified" : "Rejected"} by{" "}
                          {cert.verifiedBy.name}
                          {cert.verifiedAt &&
                            ` on ${new Date(cert.verifiedAt).toLocaleDateString()}`}
                        </p>
                      </CardContent>
                    )}
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}