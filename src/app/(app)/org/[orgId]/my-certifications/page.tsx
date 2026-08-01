/**
 * My Certifications Page (Boundary Layer)
 *
 * A staff member's own qualifications: what has been verified, what is waiting
 * on a manager, what was rejected and why, and what is about to lapse.
 *
 * This page exists because there was previously NO way for a staff member to
 * submit a certification at all — the org-wide list is gated to admins and
 * managers, and nothing in the UI called POST /certifications. Eligibility
 * depends on verified certifications, so a staff member could be silently
 * unqualified for work with no screen to fix it on.
 *
 * Reads from GET /my-certifications (membership-scoped, any role) rather than
 * the org endpoint, so it works for staff without widening that endpoint's gate.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { CertificationStateIcon } from "@/components/ui/certification-state-icon";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  EXPIRY_WARNING_DAYS,
  REJECTION_REASON_LABELS,
  certificationDisplayState,
  dateInputToIso,
  daysUntilExpiry,
  formatCertDate,
  isoToDateInput,
  relativeTime,
  type CertificationDisplayState,
} from "@/lib/certification-display";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Shape returned by GET /my-certifications — see findByMembershipId. */
interface MyCertification {
  id: string;
  name: string;
  issuedDate: string;
  expiryDate: string | null;
  documentUrl: string | null;
  status: string;
  rejectionReason: string | null;
  rejectionNotes: string | null;
  verifiedAt: string | null;
  createdAt: string;
  verifiedBy: { id: string; name: string | null } | null;
}

interface FormState {
  name: string;
  issuedDate: string;
  expiryDate: string;
  documentUrl: string;
}

interface CertificationDefinition {
  id: string;
  name: string;
  description: string | null;
}

const EMPTY_FORM: FormState = {
  name: "",
  issuedDate: "",
  expiryDate: "",
  documentUrl: "",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function reasonSentence(cert: MyCertification): string | null {
  if (!cert.rejectionReason && !cert.rejectionNotes) return null;
  const label = cert.rejectionReason
    ? REJECTION_REASON_LABELS[cert.rejectionReason] ?? cert.rejectionReason
    : null;
  return [label, cert.rejectionNotes].filter(Boolean).join(" — ");
}

/* ------------------------------------------------------------------ */
/*  Stat Tile                                                          */
/* ------------------------------------------------------------------ */

function StatTile({
  label,
  value,
  detail,
  accentColour,
  valueColour,
}: {
  label: string;
  value: number;
  detail: string;
  accentColour: string;
  valueColour?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card p-3.5 sm:p-4">
      <div
        className="absolute right-0 top-0 h-10 w-10 rounded-bl-[40px]"
        style={{ background: accentColour }}
      />
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={`mt-1 text-xl font-bold tracking-tight sm:text-2xl ${
          valueColour ?? ""
        }`}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{detail}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function MyCertificationsPage() {
  const params = useParams();
  const orgId = params.orgId as string;

  const [certifications, setCertifications] = useState<MyCertification[]>([]);
  const [definitions, setDefinitions] = useState<CertificationDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [withdrawTarget, setWithdrawTarget] = useState<MyCertification | null>(
    null
  );
  const [withdrawing, setWithdrawing] = useState(false);

  const fetchCertifications = useCallback(async () => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/my-certifications`);
      const data = await res.json();

      // A 403 body is `{ error }`, not an array — guard before any array method.
      if (!res.ok || !Array.isArray(data)) {
        setError(
          typeof data?.error === "string"
            ? data.error
            : "Failed to load your certifications"
        );
        setCertifications([]);
        return;
      }

      setCertifications(data);
      setError(null);
    } catch {
      setError("Failed to load your certifications");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  const fetchDefinitions = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/organizations/${orgId}/certification-definitions`
      );
      const data = await response.json();
      setDefinitions(
        response.ok && Array.isArray(data.definitions) ? data.definitions : []
      );
    } catch {
      setDefinitions([]);
    }
  }, [orgId]);

  useEffect(() => {
    void Promise.all([fetchCertifications(), fetchDefinitions()]);
  }, [fetchCertifications, fetchDefinitions]);

  /**
   * Opens the form blank, or prefilled from the certificate being replaced.
   *
   * Resubmitting and renewing are different situations. A rejected or revoked
   * certificate is usually the SAME document — the photo was unreadable, the
   * details were queried — so its dates carry over and only the link needs
   * changing. A renewal is a genuinely new certificate, so its dates are left
   * empty rather than prefilled with the old ones, which would otherwise be
   * submitted unchanged by a hurried tap on a phone.
   */
  function openForm(source?: MyCertification) {
    setFormError(null);

    if (!source) {
      setForm(EMPTY_FORM);
      setFormOpen(true);
      return;
    }

    const isCorrection = source.status === "rejected" || source.status === "revoked";

    setForm({
      name: source.name,
      issuedDate: isCorrection ? isoToDateInput(source.issuedDate) : "",
      expiryDate: isCorrection ? isoToDateInput(source.expiryDate) : "",
      documentUrl: source.documentUrl ?? "",
    });
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setForm(EMPTY_FORM);
    setFormError(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    const name = form.name.trim();
    if (!name) {
      setFormError("Give the certification a name");
      return;
    }

    const issuedDate = dateInputToIso(form.issuedDate);
    if (!issuedDate) {
      setFormError("Pick the date the certification was issued");
      return;
    }

    const expiryDate = dateInputToIso(form.expiryDate);
    if (expiryDate && new Date(expiryDate) <= new Date(issuedDate)) {
      setFormError("The expiry date has to be after the issued date");
      return;
    }

    const documentUrl = form.documentUrl.trim();
    if (documentUrl && !/^https?:\/\/\S+$/i.test(documentUrl)) {
      // The API validates with `z.string().url()`; saying so here saves a round
      // trip and a generic "Validation failed".
      setFormError("The document link needs to start with http:// or https://");
      return;
    }

    setSubmitting(true);
    setFormError(null);
    setSuccess(null);

    try {
      const res = await fetch(`/api/organizations/${orgId}/certifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Optional fields are omitted rather than sent empty: `z.string().url()`
        // and `.datetime()` both reject "".
        body: JSON.stringify({
          name,
          issuedDate,
          ...(expiryDate ? { expiryDate } : {}),
          ...(documentUrl ? { documentUrl } : {}),
        }),
      });

      if (!res.ok) {
        const result = await res.json().catch(() => ({}));
        setFormError(result.error || "Could not submit that certification");
        return;
      }

      setSuccess(`"${name}" submitted for review`);
      closeForm();
      await fetchCertifications();
    } catch {
      setFormError("Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Withdraws a still-pending submission. The API refuses once a manager has
   * acted — a reviewed certificate is an audit artifact and gets revoked, not
   * deleted — so this button only ever appears on a pending row.
   */
  async function handleWithdraw() {
    if (!withdrawTarget || withdrawing) return;

    setWithdrawing(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/certifications/${withdrawTarget.id}`,
        { method: "DELETE" }
      );

      if (!res.ok) {
        const result = await res.json().catch(() => ({}));
        setError(result.error || "Could not withdraw that submission");
        return;
      }

      setSuccess(`"${withdrawTarget.name}" withdrawn`);
      setWithdrawTarget(null);
      await fetchCertifications();
    } catch {
      setError("Something went wrong");
    } finally {
      setWithdrawing(false);
    }
  }

  if (loading) return <PageLoading label="Loading your certifications" />;

  /* ---------------------------------------------------------------- */
  /*  Derive states and counts                                        */
  /* ---------------------------------------------------------------- */

  // One `now` for the whole render, so the tiles and the cards agree.
  const now = new Date();

  const withState = certifications.map((cert) => ({
    cert,
    state: certificationDisplayState(cert.status, cert.expiryDate, now),
  }));

  const count = (...states: CertificationDisplayState[]) =>
    withState.filter((entry) => states.includes(entry.state)).length;

  const verifiedCount = count("verified");
  const pendingCount = count("pending");
  const expiringCount = count("expiring");
  // Rejected, revoked and expired all mean the same thing to the holder: it is
  // not counting, and only they can do something about it.
  const attentionCount = count("rejected", "revoked", "expired");

  const STATE_ORDER: CertificationDisplayState[] = [
    "expiring",
    "expired",
    "rejected",
    "revoked",
    "pending",
    "verified",
  ];
  const rank = (state: CertificationDisplayState) => {
    const index = STATE_ORDER.indexOf(state);
    return index === -1 ? STATE_ORDER.length : index;
  };

  // Whatever needs the holder's action floats to the top.
  const ordered = [...withState].sort((a, b) => {
    const byUrgency = rank(a.state) - rank(b.state);
    if (byUrgency !== 0) return byUrgency;
    return (
      new Date(b.cert.createdAt).getTime() - new Date(a.cert.createdAt).getTime()
    );
  });

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
            My Certifications
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Submit your qualifications so you can be assigned to tasks that
            require them
          </p>
        </div>
        {!formOpen && (
          <button
            onClick={() => openForm()}
            className="shrink-0 self-start rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:from-indigo-700 hover:to-indigo-600"
          >
            + Add certification
          </button>
        )}
      </div>

      {error && (
        <AlertBanner
          message={error}
          variant="error"
          className="mb-4"
          onDismiss={() => setError(null)}
        />
      )}
      {success && (
        <AlertBanner
          message={success}
          variant="success"
          className="mb-4"
          onDismiss={() => setSuccess(null)}
        />
      )}

      {/* ── Stat tiles ── */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile
          label="Verified"
          value={verifiedCount}
          detail="counting toward eligibility"
          accentColour="rgba(34,197,94,.08)"
          valueColour="text-green-600 dark:text-green-400"
        />
        <StatTile
          label="Awaiting review"
          value={pendingCount}
          detail="submitted, not yet checked"
          accentColour="rgba(245,158,11,.09)"
          valueColour={
            pendingCount > 0 ? "text-amber-600 dark:text-amber-400" : ""
          }
        />
        <StatTile
          label="Expiring soon"
          value={expiringCount}
          detail={`renew within ${EXPIRY_WARNING_DAYS} days`}
          accentColour="rgba(245,158,11,.09)"
          valueColour={
            expiringCount > 0 ? "text-amber-600 dark:text-amber-400" : ""
          }
        />
        <StatTile
          label="Needs attention"
          value={attentionCount}
          detail="rejected, revoked or expired"
          accentColour="rgba(148,163,184,.09)"
          valueColour={attentionCount > 0 ? "text-red-600 dark:text-red-400" : ""}
        />
      </div>

      {/* ── Submission form ── */}
      {formOpen && (
        <form
          onSubmit={handleSubmit}
          className="mb-4 overflow-hidden rounded-xl border border-border bg-card"
        >
          <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 dark:bg-indigo-950/30">
              <ShieldCheck
                className="h-[18px] w-[18px] text-indigo-600 dark:text-indigo-400"
                aria-hidden="true"
              />
            </div>
            <div>
              <h3 className="text-sm font-semibold">Add a certification</h3>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                A manager reviews it before it counts toward your eligibility
              </p>
            </div>
          </div>

          {formError && (
            <div className="px-4 pt-4">
              <AlertBanner message={formError} variant="error" />
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="cert-name"
                className="mb-1.5 block text-xs font-semibold"
              >
                Certification name <span className="text-red-600">*</span>
              </label>
              {definitions.length > 0 ? (
                <select
                  id="cert-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  className="h-9 w-full rounded-lg border border-border bg-background px-3 text-[13px] outline-none focus:border-indigo-400"
                >
                  <option value="">Select a certification</option>
                  {definitions.map((definition) => (
                    <option key={definition.id} value={definition.name}>
                      {definition.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="cert-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  maxLength={200}
                  required
                  placeholder="e.g. Food Safety Level 2"
                  className="h-9 w-full rounded-lg border border-border bg-background px-3 text-[13px] outline-none focus:border-indigo-400"
                />
              )}
              {definitions.find((definition) => definition.name === form.name)
                ?.description && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {
                    definitions.find(
                      (definition) => definition.name === form.name
                    )?.description
                  }
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="cert-issued"
                className="mb-1.5 block text-xs font-semibold"
              >
                Issued date <span className="text-red-600">*</span>
              </label>
              <input
                id="cert-issued"
                type="date"
                value={form.issuedDate}
                onChange={(e) => setForm({ ...form, issuedDate: e.target.value })}
                required
                className="h-9 w-full rounded-lg border border-border bg-background px-3 text-[13px] outline-none focus:border-indigo-400"
              />
            </div>

            <div>
              <label
                htmlFor="cert-expiry"
                className="mb-1.5 block text-xs font-semibold"
              >
                Expiry date
              </label>
              <input
                id="cert-expiry"
                type="date"
                value={form.expiryDate}
                // The browser blocks an expiry on or before the issue date
                // before the form is even submitted; handleSubmit re-checks it
                // because `min` is trivially bypassed.
                min={form.issuedDate || undefined}
                onChange={(e) => setForm({ ...form, expiryDate: e.target.value })}
                className="h-9 w-full rounded-lg border border-border bg-background px-3 text-[13px] outline-none focus:border-indigo-400"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Leave blank if it does not expire
              </p>
            </div>

            <div>
              <label
                htmlFor="cert-doc"
                className="mb-1.5 block text-xs font-semibold"
              >
                Link to document
              </label>
              <input
                id="cert-doc"
                type="url"
                value={form.documentUrl}
                onChange={(e) =>
                  setForm({ ...form, documentUrl: e.target.value })
                }
                placeholder="https://..."
                className="h-9 w-full rounded-lg border border-border bg-background px-3 text-[13px] outline-none focus:border-indigo-400"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Paste a link to a scan or photo of the certificate
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-border bg-muted/40 px-4 py-3">
            <button
              type="button"
              onClick={closeForm}
              disabled={submitting}
              className="rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:from-indigo-700 hover:to-indigo-600 disabled:cursor-default disabled:opacity-45"
            >
              {submitting ? "Submitting…" : "Submit for review"}
            </button>
          </div>
        </form>
      )}

      {/* ── List ── */}
      {ordered.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No certifications yet"
          description="Add your qualifications here so managers can verify them. Once verified, you become eligible for tasks that require them."
          action={
            !formOpen ? (
              <button
                onClick={() => openForm()}
                className="rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:from-indigo-700 hover:to-indigo-600"
              >
                Add your first certification
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {ordered.map(({ cert, state }) => {
            const sentence = reasonSentence(cert);
            const daysLeft = cert.expiryDate
              ? daysUntilExpiry(cert.expiryDate, now)
              : null;

            return (
              <div
                key={cert.id}
                className={`flex flex-col gap-3 rounded-xl border border-border bg-card p-3.5 sm:flex-row sm:items-start sm:p-4 ${
                  state === "pending" ? "border-l-[3px] border-l-amber-500" : ""
                }`}
              >
                <CertificationStateIcon state={state} />

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 break-words text-[14px] font-semibold">
                      {cert.name}
                    </p>
                    <StatusBadge value={state} palette="certification" />
                  </div>

                  <div className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1 text-[12.5px] text-muted-foreground">
                    <span>
                      Issued{" "}
                      <span className="font-semibold text-foreground">
                        {formatCertDate(cert.issuedDate)}
                      </span>
                    </span>
                    {cert.expiryDate ? (
                      <span>
                        {state === "expired" ? "Expired" : "Expires"}{" "}
                        <span className="font-semibold text-foreground">
                          {formatCertDate(cert.expiryDate)}
                        </span>
                      </span>
                    ) : (
                      <span>No expiry</span>
                    )}
                    {state === "pending" ? (
                      <span>
                        Submitted{" "}
                        <span className="font-semibold text-foreground">
                          {relativeTime(cert.createdAt, now)}
                        </span>
                      </span>
                    ) : (
                      cert.verifiedBy && (
                        <span>
                          Reviewed by{" "}
                          <span className="font-semibold text-foreground">
                            {cert.verifiedBy.name ?? "a manager"}
                          </span>
                        </span>
                      )
                    )}
                  </div>

                  {state === "pending" && (
                    <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-[12.5px] leading-relaxed text-muted-foreground">
                      Waiting for a manager to review. It will not count toward
                      eligibility until then.
                    </p>
                  )}
                  {state === "expiring" && daysLeft !== null && (
                    <p className="mt-2 rounded-lg bg-amber-100 px-3 py-2 text-[12.5px] leading-relaxed text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                      <span className="font-semibold">
                        {daysLeft === 0
                          ? "Expires today."
                          : `Expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`}
                      </span>{" "}
                      Submit a renewal to stay eligible for tasks that need{" "}
                      {cert.name}.
                    </p>
                  )}
                  {state === "expired" && (
                    <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-[12.5px] leading-relaxed text-muted-foreground">
                      This has lapsed and no longer counts toward eligibility.
                      Submit a renewal to get it back.
                    </p>
                  )}
                  {(state === "rejected" || state === "revoked") && (
                    <p className="mt-2 rounded-lg bg-red-100 px-3 py-2 text-[12.5px] leading-relaxed text-red-800 dark:bg-red-950/40 dark:text-red-300">
                      <span className="font-semibold">
                        {state === "revoked" ? "Revoked" : "Rejected"}
                      </span>
                      {sentence ? ` — ${sentence}` : ". No reason was recorded."}
                    </p>
                  )}

                  {cert.documentUrl && (
                    <a
                      href={cert.documentUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <path d="M14 2v6h6" />
                      </svg>
                      View your document
                    </a>
                  )}
                </div>

                {/* Only one action ever applies to a given state. */}
                {state === "pending" && (
                  <div className="flex shrink-0">
                    <button
                      onClick={() => setWithdrawTarget(cert)}
                      className="flex-1 rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground sm:flex-none"
                    >
                      Withdraw
                    </button>
                  </div>
                )}
                {(state === "expiring" ||
                  state === "expired" ||
                  state === "rejected" ||
                  state === "revoked") && (
                  <div className="flex shrink-0">
                    <button
                      onClick={() => openForm(cert)}
                      className="flex-1 rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-semibold text-indigo-600 transition-colors hover:border-indigo-300 dark:text-indigo-400 sm:flex-none"
                    >
                      {state === "rejected" || state === "revoked"
                        ? "Resubmit"
                        : "Submit renewal"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {withdrawTarget && (
        <ConfirmDialog
          open
          title={`Withdraw "${withdrawTarget.name}"?`}
          description="This removes the submission entirely. You can submit it again at any time — nothing is kept on your record."
          confirmLabel="Withdraw submission"
          variant="destructive"
          loading={withdrawing}
          onConfirm={() => void handleWithdraw()}
          onCancel={() => setWithdrawTarget(null)}
        />
      )}
    </div>
  );
}
