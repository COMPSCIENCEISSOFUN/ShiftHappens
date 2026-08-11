/**
 * Certifications Management Page (Boundary Layer)
 *
 * Admin/Manager review queue: every certification in the organisation, grouped
 * by the member who holds it, with the pending ones surfaced first.
 *
 * Filtering is client-side, unlike the notifications page. That is deliberate:
 * two of the six states shown — "expiring" and "expired" — are derived from
 * `expiryDate` and are not stored, so `?status=` cannot express them. Fetching
 * once and deriving locally keeps every pill counting the same population.
 * Certifications are per-member records, so the row count is bounded by
 * headcount rather than by activity.
 *
 * Rejecting and revoking both go through a reason dialog. `ConfirmDialog` takes
 * a plain string description and cannot host a radio group, so this is a local
 * modal following the Departments pattern.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { FileText, FileX2, Search, SearchX, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import {
  DATE_RANGE_MESSAGE,
  parseDateRange,
  withinDateRange,
} from "@/lib/date-range";
import { toast } from "sonner";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { CertificationStateIcon } from "@/components/ui/certification-state-icon";
import { StatTile } from "@/components/ui/stat-tile";
import { getSystemRoleLabel } from "@/lib/role-config";
import {
  EXPIRY_WARNING_DAYS,
  REJECTION_NOTES_MAX,
  REJECTION_REASONS,
  REJECTION_REASON_LABELS,
  certificationDisplayState,
  daysUntilExpiry,
  formatCertDate,
  relativeTime,
  type CertificationDisplayState,
} from "@/lib/certification-display";
import { usePermissions } from "@/components/layout/permission-provider";
import {
  RecognisedList,
  type RecognisedCertification,
} from "@/components/certifications/recognised-list";
import { PRIMARY_BUTTON } from "@/components/ui/button-styles";
import { cn } from "@/lib/utils";
import { canBeRostered } from "@/lib/role-config";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Shape returned by GET /certifications — see CertificationRepository. */
interface Certification {
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
  membership: {
    id: string;
    role: string;
    employmentType: string | null;
    user: { id: string; name: string | null; email: string };
  };
}

/** Members whose certifications the org expects to hold — see membersOnFile. */
interface Member {
  id: string;
  role: string;
  status: string;
  employmentType: string | null;
  user: { id: string; name: string | null; email: string };
}

type FilterKey =
  | "all"
  | "pending"
  | "verified"
  | "expiring"
  | "expired"
  | "rejected"
  | "revoked"
  | "uncertified";

/**
 * Narrows an arbitrary `?status=` value to a filter this page knows.
 *
 * Derived from FILTERS rather than a second hand-written list, so a pill added
 * there is deep-linkable without anyone remembering to update a guard.
 */
function isFilterKey(value: string): value is FilterKey {
  return FILTERS.some((f) => f.key === value);
}

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "verified", label: "Verified" },
  { key: "expiring", label: "Expiring" },
  { key: "expired", label: "Expired" },
  { key: "rejected", label: "Rejected" },
  // Revoked is its own pill rather than being folded into Rejected. The two are
  // stored separately on purpose — one was never accepted, the other was
  // honoured and later withdrawn — and merging them here would leave a revoked
  // certificate invisible under every filter except "All".
  { key: "revoked", label: "Revoked" },
  // The odd one out: this view lists MEMBERS, not certifications.
  //
  // Every other pill answers "what has been submitted?". This one answers "who
  // has submitted nothing?", which a grouped-by-holder list structurally cannot
  // show — someone with no certifications has nothing to group under. For a
  // compliance screen that is usually the more urgent question: an active,
  // assignable member with no qualifications on record.
  //
  // Its badge therefore counts people, and is deliberately NOT part of the
  // "All" total, which counts certifications.
  { key: "uncertified", label: "Uncertified" },
];

/**
 * The six pill keys that are certification states, as opposed to "all" (a total)
 * and "uncertified" (a count of people). Every member is also a `CertificationDisplayState`,
 * so `counts[state]` indexes without a cast.
 */
const CERT_STATE_KEYS: CertificationDisplayState[] = [
  "pending",
  "verified",
  "expiring",
  "expired",
  "rejected",
  "revoked",
];

/** Lower-case nouns for the "No ___" empty state. */
const FILTER_NOUNS: Record<FilterKey, string> = {
  all: "certifications",
  pending: "certifications awaiting review",
  verified: "verified certifications",
  expiring: "certifications expiring soon",
  expired: "expired certifications",
  rejected: "rejected certifications",
  revoked: "revoked certifications",
  uncertified: "uncertified members",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Two-letter avatar from name. Matches the members page. */
function initials(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

const AVATAR_COLOURS = [
  "bg-indigo-600",
  "bg-cyan-600",
  "bg-emerald-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-purple-600",
  "bg-teal-600",
  "bg-orange-600",
];

function avatarColour(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLOURS[Math.abs(h) % AVATAR_COLOURS.length];
}

/** Turns a stored reason + notes into one sentence for the card. */
function reasonSentence(cert: Certification): string | null {
  if (!cert.rejectionReason && !cert.rejectionNotes) return null;
  const label = cert.rejectionReason
    ? REJECTION_REASON_LABELS[cert.rejectionReason] ?? cert.rejectionReason
    : null;
  return [label, cert.rejectionNotes].filter(Boolean).join(" — ");
}

function memberName(cert: Certification): string {
  return cert.membership.user.name || cert.membership.user.email;
}

/* ------------------------------------------------------------------ */
/*  Stat Tile                                                          */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/*  Reason dialog — reject or revoke                                   */
/* ------------------------------------------------------------------ */

interface ReasonTarget {
  cert: Certification;
  mode: "reject" | "revoke";
}

function ReasonDialog({
  target,
  submitting,
  onCancel,
  onConfirm,
}: {
  target: ReasonTarget;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: (reason: string, notes: string) => void;
}) {
  const [reason, setReason] = useState<string>("");
  const [notes, setNotes] = useState("");

  const isRevoke = target.mode === "revoke";
  const name = memberName(target.cert);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-border bg-card shadow-xl">
        <div className="border-b border-border px-5 py-4">
          <h3 className="text-base font-semibold">
            {isRevoke ? "Revoke" : "Reject"} &ldquo;{target.cert.name}&rdquo;
          </h3>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {isRevoke
              ? `${name} stops being eligible for tasks that require it immediately. The record is kept for the audit trail.`
              : `${name} will be notified, including the reason you pick.`}
          </p>
        </div>

        <div className="px-5 py-4">
          <fieldset>
            <legend className="mb-2 text-xs font-semibold">
              Reason <span className="text-red-600">*</span>
            </legend>
            <div className="flex flex-col gap-1.5">
              {REJECTION_REASONS.map((option) => {
                const selected = reason === option.value;
                return (
                  <label
                    key={option.value}
                    className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[13px] transition-colors ${
                      selected
                        ? "border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950"
                        : "border-border hover:border-indigo-300 dark:hover:border-indigo-600"
                    }`}
                  >
                    <input
                      type="radio"
                      name="rejectionReason"
                      value={option.value}
                      checked={selected}
                      onChange={() => setReason(option.value)}
                      className="mt-0.5 accent-indigo-600"
                    />
                    <span className="min-w-0">
                      <span className="block font-semibold">{option.label}</span>
                      <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="mt-3">
            <label
              htmlFor="rejectionNotes"
              className="mb-1.5 block text-xs font-semibold"
            >
              Notes <span className="text-muted-foreground">(optional)</span>
            </label>
            <textarea
              id="rejectionNotes"
              value={notes}
              onChange={(e) => setNotes(e.target.value.slice(0, REJECTION_NOTES_MAX))}
              rows={3}
              placeholder="Anything the employee needs in order to fix it..."
              className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-indigo-400"
            />
            <p className="mt-1 text-right text-[11px] text-muted-foreground">
              {notes.length}/{REJECTION_NOTES_MAX}
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(reason, notes.trim())}
            // The API refuses a decision with no reason; disabling the button
            // says so before the round trip instead of after it.
            disabled={!reason || submitting}
            className="rounded-lg bg-red-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-red-700 disabled:cursor-default disabled:opacity-45"
          >
            {submitting
              ? "Saving…"
              : isRevoke
                ? "Revoke certification"
                : "Reject certification"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function CertificationsPage() {
  const { can } = usePermissions();
  const params = useParams();
  const orgId = params.orgId as string;

  const [certifications, setCertifications] = useState<Certification[]>([]);
  // null means "we could not load the member list", which is different from an
  // empty one — the difference decides whether the Uncertified badge shows a
  // number or a dash. Reporting 0 for a failed request would be a lie.
  const [members, setMembers] = useState<Member[] | null>(null);
  // The organisation's recognised certificate names — the vocabulary a shift
  // may require, edited from the panel below the queue.
  const [types, setTypes] = useState<RecognisedCertification[]>([]);
  const [typesBusy, setTypesBusy] = useState(false);
  /**
   * Initial filter, honouring `?status=` on the way in.
   *
   * The dashboard's "3 certifications awaiting verification" alert used to
   * land here on "All", so the reader arrived at a review queue and then had
   * to find the pending ones themselves — the alert named a subset and the
   * page showed everything.
   *
   * Read once as the initial state rather than kept in sync with the URL:
   * filtering is client-side by design (expiring and expired are derived from
   * dates, not stored) and a manager who then clicks another pill should not
   * have the deep link argue with them.
   */
  const searchParams = useSearchParams();
  const [filter, setFilter] = useState<FilterKey>(() => {
    const requested = searchParams.get("status");
    return requested && isFilterKey(requested) ? requested : "all";
  });
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  /*
   * An EXPIRY range, not an issue-date one.
   *
   * "Whose certificates lapse before the end of the month" is the question a
   * compliance officer actually asks; when a certificate was issued is a fact
   * about the past that changes nothing. Not debounced, unlike the search box
   * beside it — a picker is one deliberate act, not one per keystroke.
   *
   * Filtered in the browser like everything else here, which this page's own
   * docblock argues for: expiring and expired are DERIVED from `expiryDate`
   * against the clock, so they are not states the server can be asked about.
   * The rule is shared with tasks and the leave register even though the
   * mechanism is not.
   */
  const [expiryFrom, setExpiryFrom] = useState("");
  const [expiryTo, setExpiryTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [reasonTarget, setReasonTarget] = useState<ReasonTarget | null>(null);
  const [dialogSubmitting, setDialogSubmitting] = useState(false);

  // Debounced so typing does not re-filter on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim().toLowerCase()), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const fetchCertifications = useCallback(async () => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/certifications`);
      const data = await res.json();

      // A 403 body is `{ error }`, not an array. Without this the page threw on
      // `.filter` and rendered nothing but a blank screen.
      if (!res.ok || !Array.isArray(data)) {
        setError(
          typeof data?.error === "string"
            ? data.error
            : "Failed to load certifications"
        );
        setCertifications([]);
        return;
      }

      setCertifications(data);
      setError(null);
    } catch {
      setError("Failed to load certifications");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  /**
   * The member list, needed only to work out who has submitted nothing.
   *
   * A failure here must not take the page down — the review queue is the point
   * of the screen and does not depend on this. It fails quietly to `null`, and
   * the Uncertified pill says so rather than claiming zero.
   *
   * Note this endpoint is department-scoped for managers while the certification
   * list is not, so a manager's Uncertified view covers their own departments
   * while the other pills cover the whole organisation.
   */
  const fetchMembers = useCallback(async () => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/members`);
      const data = await res.json();
      setMembers(res.ok && Array.isArray(data) ? data : null);
    } catch {
      setMembers(null);
    }
  }, [orgId]);

  /** The organisation's recognised certificate names. */
  const fetchTypes = useCallback(async () => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/certification-types`);
      const data = await res.json();
      setTypes(res.ok && Array.isArray(data) ? data : []);
    } catch {
      setTypes([]);
    }
  }, [orgId]);

  useEffect(() => {
    // Parallel: neither the member list nor the recognised names is a
    // prerequisite for the certifications themselves.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: loads certifications, members and the recognised list from the server on mount
    void Promise.all([fetchCertifications(), fetchMembers(), fetchTypes()]);
  }, [fetchCertifications, fetchMembers, fetchTypes]);

  /**
   * Adds a name to the organisation's list.
   *
   * The refusal that matters is a duplicate, and the server answers 409 with
   * the name in the message — including for one that differs only in case,
   * which is stricter than the database index and has to be, since eligibility
   * lower-cases both sides before comparing.
   */
  async function handleAddType(name: string) {
    setTypesBusy(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/certification-types`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Could not add that certificate");
        return;
      }
      setError(null);
      toast.success(`"${name}" added to the list`);
      await fetchTypes();
    } catch {
      setError("Could not add that certificate");
    } finally {
      setTypesBusy(false);
    }
  }

  /**
   * Removes one, unless a shift still requires it.
   *
   * The server refuses with a count in that case, and the count is the whole
   * value of the message: removing a name does not break the shifts that
   * require it, but it does mean the next person to edit one would silently
   * drop the requirement the picker can no longer represent.
   */
  async function handleRemoveType(type: { id: string; name: string }) {
    setTypesBusy(true);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/certification-types/${type.id}`,
        { method: "DELETE" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Could not remove that certificate");
        return;
      }
      setError(null);
      toast.success(`"${type.name}" removed from the list`);
      await fetchTypes();
    } catch {
      setError("Could not remove that certificate");
    } finally {
      setTypesBusy(false);
    }
  }

  /** Verify a pending certification. No reason needed. */
  async function handleVerify(cert: Certification) {
    if (busyIds.includes(cert.id)) return;

    setBusyIds((prev) => [...prev, cert.id]);
    setError(null);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/certifications/${cert.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "verified" }),
        }
      );

      if (!res.ok) {
        const result = await res.json().catch(() => ({}));
        setError(result.error || "Failed to verify certification");
        return;
      }

      toast.success(`Verified "${cert.name}" for ${memberName(cert)}`);
      await fetchCertifications();
    } catch {
      setError("Something went wrong");
    } finally {
      setBusyIds((prev) => prev.filter((id) => id !== cert.id));
    }
  }

  /**
   * Reject a pending certification, or revoke a verified one.
   * Different verbs, same dialog: PATCH decides a submission, POST withdraws
   * one already honoured.
   */
  async function handleReasonConfirm(reason: string, notes: string) {
    if (!reasonTarget) return;

    const { cert, mode } = reasonTarget;
    setDialogSubmitting(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/certifications/${cert.id}`,
        {
          method: mode === "revoke" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(mode === "reject" ? { status: "rejected" } : {}),
            rejectionReason: reason,
            // Prisma writes `undefined` as "leave alone"; omitting an empty
            // string keeps it out of the payload entirely.
            ...(notes ? { rejectionNotes: notes } : {}),
          }),
        }
      );

      if (!res.ok) {
        const result = await res.json().catch(() => ({}));
        setError(
          result.error ||
            `Failed to ${mode === "revoke" ? "revoke" : "reject"} certification`
        );
        return;
      }

      toast.success(
        `${mode === "revoke" ? "Revoked" : "Rejected"} "${cert.name}" for ${memberName(cert)}`
      );
      setReasonTarget(null);
      await fetchCertifications();
    } catch {
      setError("Something went wrong");
    } finally {
      setDialogSubmitting(false);
    }
  }


  if (loading) return <PageLoading label="Loading certifications" />;

  /*
   * The sidebar no longer links here without `certifications:review`, but the URL
   * still resolved — and this page had no check of its own, so it
   * rendered its full surface and every action returned 403.
   *
   * Not a security boundary. The routes enforce this independently;
   * this is so the product does not offer what it will refuse.
   */
  if (!can("certifications:review")) {
    return (
      <div className="w-full">
        <EmptyState
          title="Certification review is for managers and admins"
          description="Your own certificates are under My Certifications."
        />
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Derive states, counts, filtered set                              */
  /* ---------------------------------------------------------------- */

  // One `now` for the whole render, so a certificate cannot be counted as
  // "expiring" in a tile and "expired" in its own card.
  const now = new Date();

  const withState = certifications.map((cert) => ({
    cert,
    state: certificationDisplayState(cert.status, cert.expiryDate, now),
  }));

  const counts: Record<FilterKey, number> = {
    all: withState.length,
    pending: 0,
    verified: 0,
    expiring: 0,
    expired: 0,
    rejected: 0,
    revoked: 0,
    // Overwritten below from the member list; it counts people, not
    // certifications, so it is not incremented by the loop.
    uncertified: 0,
  };
  // Guarded against an unrecognised status, which certificationDisplayState
  // passes straight through rather than relabelling. Checked against an explicit
  // list rather than `state in counts`, because `counts` also carries the `none`
  // key, which is a member count and must never be incremented from here.
  for (const { state } of withState) {
    if (CERT_STATE_KEYS.includes(state)) counts[state]++;
  }

  /**
   * Members with nothing on file at all.
   *
   * Restricted to ACTIVE memberships in a scheduled role. Suspended members are
   * not being given shifts, so their paperwork is not urgent; company admins are
   * excluded on the same basis the sidebar uses — they get no "My Availability"
   * or "My Certifications" entry either, because the app already treats them as
   * people who administer the schedule rather than appear on it.
   */
  const membershipIdsWithCerts = new Set(
    certifications.map((cert) => cert.membership.id)
  );

  const membersWithoutCerts = (members ?? []).filter(
    (member) =>
      member.status === "active" &&
      // `canBeRostered` spelled out by hand. Correct today, and it would not
      // follow if ROSTERABLE_ROLES ever changed.
      canBeRostered(member.role) &&
      !membershipIdsWithCerts.has(member.id)
  );

  // null when the member list could not be loaded — the badge shows a dash
  // rather than claiming zero. This is what the Uncertified pill reads;
  // `counts.uncertified` stays 0 and is never displayed.
  const uncertifiedCount: number | null =
    members === null ? null : membersWithoutCerts.length;

  const matchingMembers = membersWithoutCerts
    .filter((member) => {
      if (!search) return true;
      const name = member.user.name || member.user.email;
      return (
        name.toLowerCase().includes(search) ||
        member.user.email.toLowerCase().includes(search)
      );
    })
    .sort((a, b) =>
      (a.user.name || a.user.email).localeCompare(b.user.name || b.user.email)
    );

  /*
   * A reversed range narrows nothing — `withinDateRange` passes everything
   * through while `problem` is set, and the notice below says why. Filtering on
   * it would empty the list, which reads as "nothing expires that month".
   *
   * A certificate with NO expiry is out whenever a range is set. One that never
   * expires does not expire in March, and letting it through because it has no
   * date to exclude it by would put every permanent certificate in every range.
   */
  const expiryRange = parseDateRange(expiryFrom, expiryTo);

  const matching = withState.filter(({ cert, state }) => {
    if (filter !== "all" && state !== filter) return false;
    if (!withinDateRange(cert.expiryDate, expiryRange)) return false;
    if (!search) return true;
    // Search covers the member and the certificate: a reviewer looking for
    // "first aid" and one looking for "Mike" are both plausible.
    return (
      memberName(cert).toLowerCase().includes(search) ||
      cert.membership.user.email.toLowerCase().includes(search) ||
      cert.name.toLowerCase().includes(search)
    );
  });

  // Group by member, pending members first so the review queue is at the top.
  const groups = new Map<
    string,
    { cert: Certification; state: CertificationDisplayState }[]
  >();
  for (const entry of matching) {
    const key = entry.cert.membership.id;
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }

  const STATE_ORDER: CertificationDisplayState[] = [
    "pending",
    "expiring",
    "expired",
    "verified",
    "rejected",
    "revoked",
  ];
  const rank = (state: CertificationDisplayState) => {
    const index = STATE_ORDER.indexOf(state);
    return index === -1 ? STATE_ORDER.length : index;
  };

  const orderedGroups = [...groups.values()]
    .map((entries) => [...entries].sort((a, b) => rank(a.state) - rank(b.state)))
    .sort((a, b) => {
      const byUrgency = rank(a[0].state) - rank(b[0].state);
      if (byUrgency !== 0) return byUrgency;
      return memberName(a[0].cert).localeCompare(memberName(b[0].cert));
    });

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
            Certifications
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Review what your team has submitted, and keep an eye on what is about
            to lapse
          </p>
        </div>
        {counts.pending > 0 && (
          <button
            onClick={() => setFilter("pending")}
            className={cn(PRIMARY_BUTTON, "shrink-0 self-start")}
          >
            Review {counts.pending} pending
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

      {/*
        The organisation's vocabulary, above the queue.

        It is the setting the rest of the screen depends on: a shift can only
        require a name that appears here, and a member recording a certificate
        is shown the same list. Reading it first is reading the definitions
        before the cases — and on an organisation that has not filled it in yet,
        having it at the bottom would leave the one thing that needs doing below
        everything that cannot be done until it is.
      */}
      <div className="mb-4">
        <RecognisedList
          types={types}
          onAdd={handleAddType}
          onRemove={handleRemoveType}
          canManage={can("certifications:review")}
          busy={typesBusy}
        />
      </div>

      {/* ── Stat tiles ── */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile
          label="Pending review"
          value={counts.pending}
          detail="waiting on you"
          accentColour="rgba(245,158,11,.09)"
          valueColour={
            counts.pending > 0 ? "text-amber-600 dark:text-amber-400" : ""
          }
        />
        <StatTile
          label="Verified"
          value={counts.verified}
          detail="currently valid"
          accentColour="rgba(34,197,94,.08)"
          valueColour="text-green-600 dark:text-green-400"
        />
        <StatTile
          label="Expiring soon"
          value={counts.expiring}
          detail={`within ${EXPIRY_WARNING_DAYS} days`}
          accentColour="rgba(245,158,11,.09)"
          valueColour={
            counts.expiring > 0 ? "text-amber-600 dark:text-amber-400" : ""
          }
        />
        <StatTile
          label="Expired"
          value={counts.expired}
          detail="no longer counts"
          accentColour="rgba(148,163,184,.09)"
          valueColour="text-muted-foreground"
        />
      </div>

      {/* ── Filters ── */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* Seven pills would stack into four rows on a phone; scrolling them
            horizontally keeps the list itself above the fold. */}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-1">
          {FILTERS.map(({ key, label }) => {
            const active = filter === key;
            return (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-all ${
                  active
                    ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-950 dark:text-indigo-300"
                    : "border-border bg-card text-muted-foreground hover:border-indigo-300 hover:text-indigo-600 dark:hover:border-indigo-600 dark:hover:text-indigo-400"
                }`}
              >
                {label}
                <span
                  className={`inline-flex min-w-[18px] items-center justify-center rounded-full px-1 py-0 text-[11px] font-bold ${
                    active
                      ? "bg-indigo-600 text-white dark:bg-indigo-500"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {key === "uncertified" ? uncertifiedCount ?? "—" : counts[key]}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Expires</span>
          {/* `max`/`min` bound each picker by the other, the pattern the audit
              log already used — it stops most reversals at the calendar rather
              than reporting them afterwards. Not a guard: a typed or pasted
              value slips past it in several browsers, and a hand-written URL
              never sees it at all, which is why the rule is also enforced in
              `parseDateRange` and again in the service. */}
          <input
            type="date"
            value={expiryFrom}
            max={expiryTo || undefined}
            onChange={(e) => setExpiryFrom(e.target.value)}
            aria-label="Expires on or after"
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-xs text-muted-foreground"
          />
          <input
            type="date"
            value={expiryTo}
            min={expiryFrom || undefined}
            onChange={(e) => setExpiryTo(e.target.value)}
            aria-label="Expires on or before"
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-xs text-muted-foreground"
          />
          {(expiryFrom || expiryTo) && (
            <button
              type="button"
              onClick={() => {
                setExpiryFrom("");
                setExpiryTo("");
              }}
              className="h-9 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Clear dates
            </button>
          )}
        </div>

        <div className="relative shrink-0 sm:w-60">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search member or certification..."
            aria-label="Search member or certification"
            className="h-9 pl-9 text-sm"
          />
        </div>
      </div>

      {/* Said out loud rather than inferred from an empty list — and the list
          is left unfiltered while it shows, so the reader can see the range is
          the problem and not the data. */}
      {expiryRange.problem && (
        <AlertBanner
          message={DATE_RANGE_MESSAGE[expiryRange.problem]}
          variant="error"
          className="mb-4"
        />
      )}

      {/* ── List ──
          The Uncertified view renders MEMBERS; every other view renders
          certifications grouped by member. Two shapes, so two branches. */}
      {filter === "uncertified" ? (
        members === null ? (
          <EmptyState
            icon={FileX2}
            title="Could not load the member list"
            description="This view needs the member list to work out who has submitted nothing. The certifications themselves loaded fine — the other filters still work."
            action={
              <button
                onClick={() => void fetchMembers()}
                className="rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
              >
                Try again
              </button>
            }
          />
        ) : matchingMembers.length === 0 ? (
          search ? (
            <EmptyState
              icon={SearchX}
              title="No members match your search"
              description={`Nobody without certifications matches "${searchInput.trim()}".`}
              action={
                <button
                  onClick={() => setSearchInput("")}
                  className="rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
                >
                  Clear search
                </button>
              }
            />
          ) : (
            // Good news, not an absence — worth saying so explicitly rather than
            // reusing the generic "nothing here" copy.
            <EmptyState
              icon={ShieldCheck}
              title="Nobody is uncertified"
              description="Every active staff member and manager has at least one certification on record. Nobody is unaccounted for."
            />
          )
        ) : (
          <div className="flex flex-col gap-2.5">
            <p className="text-[12.5px] text-muted-foreground">
              These members are active and assignable but have never submitted a
              certification. They are eligible only for tasks that require none.
            </p>

            {matchingMembers.map((member) => {
              const name = member.user.name || member.user.email;
              return (
                <div
                  key={member.id}
                  className="flex items-start gap-3 rounded-xl border border-dashed border-border bg-card p-3.5 sm:p-4"
                >
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${avatarColour(
                      member.id
                    )}`}
                    aria-hidden="true"
                  >
                    {initials(member.user.name, member.user.email)}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 break-words text-[14px] font-semibold">
                        {name}
                      </p>
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                        Uncertified
                      </span>
                    </div>
                    <p className="mt-1 truncate text-[12.5px] text-muted-foreground">
                      {getSystemRoleLabel(member.role, member.employmentType)}
                      {" · "}
                      {member.user.email}
                    </p>
                    <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-[12.5px] leading-relaxed text-muted-foreground">
                      Certifications are submitted by the member themselves, from
                      their own My Certifications page — you cannot add one on
                      their behalf. Ask {name.split(" ")[0]} to upload anything
                      the role requires.
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : orderedGroups.length === 0 ? (
        // Three distinct empty states: nothing has ever been submitted, nothing
        // matches the search, nothing is in this category. A single generic
        // message leaves the reviewer unsure which one they are looking at.
        search ? (
          <EmptyState
            icon={SearchX}
            title="No certifications match your search"
            description={`Nothing found for "${searchInput.trim()}". Try a member's name, or part of the certification title.`}
            action={
              <button
                onClick={() => setSearchInput("")}
                className="rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
              >
                Clear search
              </button>
            }
          />
        ) : filter !== "all" ? (
          <EmptyState
            icon={FileX2}
            title={`No ${FILTER_NOUNS[filter]}`}
            description={
              filter === "pending"
                ? "Nothing is waiting on you. New submissions appear here as soon as staff add them."
                : "Nothing in this category. Other categories may still have records."
            }
            action={
              <button
                onClick={() => setFilter("all")}
                className="rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
              >
                View all certifications
              </button>
            }
          />
        ) : (
          <EmptyState
            icon={ShieldCheck}
            title="No certifications yet"
            description="When a staff member submits a qualification it appears here for you to verify. Verified certifications let the eligibility engine match them to tasks that require one."
          />
        )
      ) : (
        <div className="space-y-1">
          {orderedGroups.map((entries) => {
            const head = entries[0].cert;
            const name = memberName(head);
            const pendingHere = entries.filter(
              (e) => e.state === "pending"
            ).length;

            return (
              <div key={head.membership.id} className="pt-4 first:pt-0">
                {/* ── Member header ── */}
                <div className="mb-2.5 flex items-center gap-2.5">
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${avatarColour(
                      head.membership.id
                    )}`}
                    aria-hidden="true"
                  >
                    {initials(head.membership.user.name, head.membership.user.email)}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-[13.5px] font-semibold">{name}</p>
                    <p className="truncate text-[11.5px] text-muted-foreground">
                      {getSystemRoleLabel(
                        head.membership.role,
                        head.membership.employmentType
                      )}
                      {pendingHere > 0 &&
                        ` · ${pendingHere} awaiting review`}
                    </p>
                  </div>
                  <span className="h-px flex-1 bg-border" />
                </div>

                {/* ── Certification cards ── */}
                <div className="flex flex-col gap-2.5">
                  {entries.map(({ cert, state }) => {
                    const busy = busyIds.includes(cert.id);
                    const sentence = reasonSentence(cert);
                    const daysLeft = cert.expiryDate
                      ? daysUntilExpiry(cert.expiryDate, now)
                      : null;

                    return (
                      <div
                        key={cert.id}
                        className={`flex flex-col gap-3 rounded-xl border border-border bg-card p-3.5 sm:flex-row sm:items-start sm:p-4 ${
                          state === "pending"
                            ? "border-l-[3px] border-l-amber-500"
                            : ""
                        }`}
                      >
                        <CertificationStateIcon state={state} />

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            {/* break-words, not truncate: a certification name
                                is what the reviewer is deciding about, so it
                                wraps rather than being cut off. */}
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
                                  {cert.verifiedAt &&
                                    `, ${formatCertDate(cert.verifiedAt)}`}
                                </span>
                              )
                            )}
                          </div>

                          {/* Explanatory note — one per card at most. */}
                          {state === "expiring" && daysLeft !== null && (
                            <p className="mt-2 rounded-lg bg-amber-100 px-3 py-2 text-[12.5px] leading-relaxed text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                              <span className="font-semibold">
                                {daysLeft === 0
                                  ? "Expires today."
                                  : `Expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`}
                              </span>{" "}
                              {name.split(" ")[0]} stops being eligible for tasks
                              requiring {cert.name} unless a renewal is
                              submitted.
                            </p>
                          )}
                          {state === "expired" && (
                            <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-[12.5px] leading-relaxed text-muted-foreground">
                              Expired certifications are kept for the record but
                              no longer count toward eligibility.
                            </p>
                          )}
                          {(state === "rejected" || state === "revoked") &&
                            sentence && (
                              <p className="mt-2 rounded-lg bg-red-100 px-3 py-2 text-[12.5px] leading-relaxed text-red-800 dark:bg-red-950/40 dark:text-red-300">
                                <span className="font-semibold">
                                  {state === "revoked" ? "Revoked" : "Rejected"}
                                </span>{" "}
                                — {sentence}
                              </p>
                            )}
                          {state === "pending" && (
                            <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-[12.5px] leading-relaxed text-muted-foreground">
                              Not counted toward eligibility until it is
                              verified.
                            </p>
                          )}

                          {cert.documentUrl && (
                            <a
                              href={cert.documentUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                            >
                              <FileText className="h-[13px] w-[13px]" aria-hidden="true" />
                              View submitted document
                            </a>
                          )}
                        </div>

                        {/* Actions stack full-width under the details on a
                            phone and sit beside them from sm up. */}
                        {cert.status === "pending" && (
                          <div className="flex shrink-0 gap-2">
                            <button
                              onClick={() => void handleVerify(cert)}
                              disabled={busy}
                              className="flex-1 rounded-lg bg-gradient-to-r from-emerald-600 to-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:from-emerald-700 hover:to-emerald-600 disabled:cursor-default disabled:opacity-45 sm:flex-none"
                            >
                              {busy ? "Saving…" : "Verify"}
                            </button>
                            <button
                              onClick={() =>
                                setReasonTarget({ cert, mode: "reject" })
                              }
                              disabled={busy}
                              className="flex-1 rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-semibold text-red-600 transition-colors hover:border-red-300 disabled:opacity-45 dark:text-red-400 sm:flex-none"
                            >
                              Reject
                            </button>
                          </div>
                        )}
                        {cert.status === "verified" && (
                          <div className="flex shrink-0">
                            <button
                              onClick={() =>
                                setReasonTarget({ cert, mode: "revoke" })
                              }
                              disabled={busy}
                              className="flex-1 rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-45 sm:flex-none"
                            >
                              Revoke
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {reasonTarget && (
        <ReasonDialog
          // Remounts per target, so the radio group and notes never carry over
          // from the previous certificate.
          key={`${reasonTarget.cert.id}-${reasonTarget.mode}`}
          target={reasonTarget}
          submitting={dialogSubmitting}
          onCancel={() => setReasonTarget(null)}
          onConfirm={(reason, notes) => void handleReasonConfirm(reason, notes)}
        />
      )}
    </div>
  );
}
