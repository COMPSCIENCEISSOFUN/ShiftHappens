/**
 * Member Mass Import Page (Boundary Layer)
 *
 * Pro+ feature — bulk import members from Excel/CSV files.
 * Flow: upload → parse → column mapping → preview with validation → confirm import
 *
 * Client-side: SheetJS parses the file, algorithmic column mapping and validation.
 * Server-side: AI column mapping + department matching (enhancement, wired later).
 * Constrained fields (role, department, employment type) use dropdowns from org data.
 */
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { AlertBanner } from "@/components/ui/alert-banner";
import { StatTile } from "@/components/ui/stat-tile";
import { EmptyState } from "@/components/ui/empty-state";
import { usePermissions } from "@/components/layout/permission-provider";
import { usePlan } from "@/components/layout/plan-provider";
import { PlanLocked } from "@/components/ui/plan-gate";
import { Download, Lock, Upload } from "lucide-react";
import * as XLSX from "xlsx";
import {
  INVITABLE_ROLES,
  EMPLOYMENT_TYPES,
  ROLE_DISPLAY,
  EMPLOYMENT_DISPLAY,
  HEADER_ALIASES,
  ROLE_ALIASES,
  EMPLOYMENT_ALIASES,
} from "@/lib/import-config";
import { PRIMARY_BUTTON } from "@/components/ui/button-styles";
import { apiErrorMessage } from "@/lib/api-error";

// ─── Types ────────────────────────────────────────────────────

interface Department {
  id: string;
  name: string;
}

interface ColumnMapping {
  source: string;
  target: string;
  method: "exact" | "alias" | "ai" | "unmatched";
}

interface Correction {
  field: string;
  from: string;
  to: string;
  method: "ai" | "alias";
}

interface ImportRow {
  rowNum: number;
  name: string;
  email: string;
  role: string;
  department: string;
  employmentType: string;
  status: "valid" | "corrected" | "error";
  corrections: Correction[];
  errors: Record<string, string>;
  skipped: boolean;
}

type Phase = "upload" | "preview" | "importing" | "complete";

// Constants imported from @/lib/import-config (single source of truth)

/**
 * Shortest cell that may be resolved to a department by substring. Anything
 * below this is treated as unmatched — see matchDepartment.
 */
const MIN_PARTIAL_DEPARTMENT_LENGTH = 3;

/* ------------------------------------------------------------------ */
/*  Stat Tile                                                          */
/* ------------------------------------------------------------------ */


// ─── Component ────────────────────────────────────────────────

export default function MemberImportPage() {
  const params = useParams();
  const router = useRouter();
  const orgId = params.orgId as string;
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── State ──────────────────────────────────────────────────
  const { can } = usePermissions();
  const plan = usePlan();
  const [phase, setPhase] = useState<Phase>("upload");
  const [departments, setDepartments] = useState<Department[]>([]);
  const [memberLimit, setMemberLimit] = useState<number | null>(null);
  const [currentMemberCount, setCurrentMemberCount] = useState(0);
  const [existingEmails, setExistingEmails] = useState<Set<string>>(new Set());
  const [fileName, setFileName] = useState("");
  const [columnMappings, setColumnMappings] = useState<ColumnMapping[]>([]);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [importResults, setImportResults] = useState<{
    created: number;
    failed: number;
    errors: string[];
  } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** False until departments, member emails and the plan limit have all landed. */
  const [referenceReady, setReferenceReady] = useState(false);

  async function fetchDepartments(): Promise<Department[]> {
    try {
      const res = await fetch(`/api/organizations/${orgId}/departments`);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch {
      return []; // Non-critical — departments list may be empty
    }
  }

  async function fetchSubscription(): Promise<{
    limit: number | null;
    current: number;
  }> {
    try {
      const res = await fetch(`/api/organizations/${orgId}/subscription`);
      if (!res.ok) return { limit: null, current: 0 };
      const data = await res.json();
      return {
        limit: data.resources?.members?.limit ?? null,
        current: data.resources?.members?.current ?? 0,
      };
    } catch {
      return { limit: null, current: 0 }; // Non-critical
    }
  }

  async function fetchExistingMembers(): Promise<Set<string>> {
    try {
      const res = await fetch(`/api/organizations/${orgId}/members`);
      if (!res.ok) return new Set();
      const data = await res.json();
      if (!Array.isArray(data)) return new Set();
      return new Set<string>(
        data.map((m: { user: { email: string } }) => m.user.email.toLowerCase())
      );
    } catch {
      return new Set(); // Non-critical
    }
  }

  async function loadReferenceData() {
    setReferenceReady(false);

    const [depts, subscription, emails] = await Promise.all([
      fetchDepartments(),
      fetchSubscription(),
      fetchExistingMembers(),
    ]);

    setDepartments(depts);
    setExistingEmails(emails);
    setMemberLimit(subscription.limit);
    setCurrentMemberCount(subscription.current);
    setReferenceReady(true);
  }

  // ─── Data fetching ──────────────────────────────────────────
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: loads departments, existing emails and the plan limit before the parser can classify anything
    loadReferenceData();
  }, [orgId]);

  /**
   * Loads everything the parser classifies against as one unit.
   *
   * These were three independent fetches while the drop zone was already live,
   * so a file dropped in that window was validated against empty reference
   * data: every department came back "not found", and every email that already
   * belonged to a member sailed through as new. Nothing on screen said the
   * check had been skipped — the preview simply lied. Resolving them together
   * behind `referenceReady` removes the window rather than narrowing it.
   */


  // ─── Column mapping (algorithmic fallback) ──────────────────

  function mapColumns(headers: string[]): ColumnMapping[] {
    const mappings: ColumnMapping[] = [];
    const usedTargets = new Set<string>();

    for (const header of headers) {
      const normalized = header.toLowerCase().trim();
      let matched = false;

      for (const [target, aliases] of Object.entries(HEADER_ALIASES)) {
        if (usedTargets.has(target)) continue;

        if (aliases.includes(normalized)) {
          mappings.push({
            source: header,
            target,
            method: normalized === target ? "exact" : "alias",
          });
          usedTargets.add(target);
          matched = true;
          break;
        }
      }

      if (!matched) {
        mappings.push({ source: header, target: "", method: "unmatched" });
      }
    }

    return mappings;
  }

  // ─── Row parsing and validation ─────────────────────────────

  function matchDepartment(value: string): { name: string; matched: boolean } {
    const needle = value.trim().toLowerCase();
    if (!needle) return { name: "", matched: true };

    // Exact match
    const exact = departments.find((d) => d.name.toLowerCase() === needle);
    if (exact) return { name: exact.name, matched: true };

    // Substring matching is a convenience for "Kitchen " vs "Kitchen Staff",
    // not a fuzzy search. It used to accept any length, so a stray "a" in the
    // department column silently imported everyone into "Bar" — a wrong match
    // is worse than an error the admin can see and fix, so short cells fall
    // through. The candidate must also be unambiguous: "Front" matching both
    // "Front of House" and "Front Desk" is a coin flip, not a match.
    if (needle.length >= MIN_PARTIAL_DEPARTMENT_LENGTH) {
      const partial = departments.filter((d) => {
        const deptName = d.name.toLowerCase();
        // The shorter side is the one doing the matching, so it is the one that
        // has to be long enough to mean something.
        if (deptName.length < MIN_PARTIAL_DEPARTMENT_LENGTH) return false;
        return deptName.includes(needle) || needle.includes(deptName);
      });
      if (partial.length === 1) return { name: partial[0].name, matched: true };
    }

    return { name: value.trim(), matched: false };
  }

  function matchRole(value: string): string | null {
    const normalized = value.toLowerCase().trim();
    return ROLE_ALIASES[normalized] ?? null;
  }

  function matchEmploymentType(value: string): string | null {
    const normalized = value.toLowerCase().trim();
    return EMPLOYMENT_ALIASES[normalized] ?? null;
  }

  function validateAndParseRows(
    rawRows: Record<string, string>[],
    mappings: ColumnMapping[]
  ): ImportRow[] {
    const targetMap = new Map<string, string>();
    for (const m of mappings) {
      if (m.target) targetMap.set(m.target, m.source);
    }

    const seenEmails = new Set<string>();

    return rawRows.map((raw, index) => {
      const corrections: Correction[] = [];
      const errors: Record<string, string> = {};

      // Extract raw values via column mapping
      const rawName = (raw[targetMap.get("name") || ""] || "").trim();
      const rawEmail = (raw[targetMap.get("email") || ""] || "").trim();
      const rawRole = (raw[targetMap.get("role") || ""] || "").trim();
      const rawDept = (raw[targetMap.get("department") || ""] || "").trim();
      const rawEmpType = (raw[targetMap.get("employmentType") || ""] || "").trim();

      // ── Name validation ──
      const name = rawName;
      if (!name) {
        errors.name = "Name is required";
      } else if (name.length < 2) {
        errors.name = "Min 2 characters required";
      }

      // ── Email validation ──
      const email = rawEmail.toLowerCase();
      if (!email) {
        errors.email = "Email is required";
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.email = "Invalid email format";
      } else if (existingEmails.has(email)) {
        errors.email = "Already a member";
      } else if (seenEmails.has(email)) {
        errors.email = "Duplicate in file";
      }
      if (email) seenEmails.add(email);

      // ── Role matching ──
      let role = "staff"; // default
      if (rawRole) {
        const matched = matchRole(rawRole);
        if (matched) {
          if (matched !== rawRole.toLowerCase()) {
            corrections.push({
              field: "role",
              from: rawRole,
              to: matched,
              method: "alias",
            });
          }
          role = matched;
        } else {
          errors.role = `Unknown role: "${rawRole}"`;
        }
      }

      // ── Department matching ──
      let department = "";
      if (rawDept) {
        const deptMatch = matchDepartment(rawDept);
        department = deptMatch.name;
        if (deptMatch.matched && deptMatch.name !== rawDept) {
          corrections.push({
            field: "department",
            from: rawDept,
            to: deptMatch.name,
            method: "alias",
          });
        } else if (!deptMatch.matched) {
          errors.department = `"${rawDept}" not found`;
        }
      }

      // ── Employment type matching ──
      let employmentType = "casual"; // default
      if (rawEmpType) {
        const matched = matchEmploymentType(rawEmpType);
        if (matched) {
          if (matched !== rawEmpType.toLowerCase().replace(/[\s-]/g, "_")) {
            corrections.push({
              field: "employmentType",
              from: rawEmpType,
              to: matched,
              method: "alias",
            });
          }
          employmentType = matched;
        } else {
          errors.employmentType = `Unknown type: "${rawEmpType}"`;
        }
      }

      // ── Determine row status ──
      const hasErrors = Object.keys(errors).length > 0;
      const hasCorrected = corrections.length > 0;
      const status: ImportRow["status"] = hasErrors
        ? "error"
        : hasCorrected
          ? "corrected"
          : "valid";

      return {
        rowNum: index + 2, // +2 for header row + 0-index
        name,
        email,
        role,
        department,
        employmentType,
        status,
        corrections,
        errors,
        skipped: false,
      };
    });
  }

  // ─── File handling ──────────────────────────────────────────

  function processFile(file: File) {
    // Belt and braces alongside the disabled drop zone: a drop event can still
    // reach the element while the reference data is in flight.
    if (!referenceReady) {
      setError("Still loading your departments and members — try again in a moment");
      return;
    }

    setError(null);

    const validTypes = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/csv",
    ];
    const validExtensions = [".xlsx", ".xls", ".csv"];
    const hasValidExt = validExtensions.some((ext) =>
      file.name.toLowerCase().endsWith(ext)
    );

    if (!validTypes.includes(file.type) && !hasValidExt) {
      setError("Please upload an Excel (.xlsx, .xls) or CSV file");
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setError("File must be under 5 MB");
      return;
    }

    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array" });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, {
          defval: "",
          raw: false,
        });

        if (jsonData.length === 0) {
          setError("File is empty or has no data rows");
          return;
        }

        if (jsonData.length > 200) {
          setError("Maximum 200 rows per import. Split your file into batches.");
          return;
        }

        const headers = Object.keys(jsonData[0]);
        const mappings = mapColumns(headers);

        // Check that we have at least name and email mapped
        const hasName = mappings.some((m) => m.target === "name");
        const hasEmail = mappings.some((m) => m.target === "email");
        if (!hasName || !hasEmail) {
          setError(
            "Could not find Name and Email columns. " +
            `Found headers: ${headers.join(", ")}. ` +
            "Please rename your columns or download the template."
          );
          return;
        }

        const parsedRows = validateAndParseRows(jsonData, mappings);
        setColumnMappings(mappings.filter((m) => m.target));
        setRows(parsedRows);
        setPhase("preview");
      } catch {
        setError("Failed to parse file. Make sure it is a valid Excel or CSV file.");
      }
    };

    reader.readAsArrayBuffer(file);
  }

  // ─── Drag and drop ─────────────────────────────────────────

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  }, [departments, existingEmails, referenceReady]);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files[0]) {
        processFile(e.target.files[0]);
      }
    },
    [departments, existingEmails, referenceReady]
  );

  // ─── Template download ─────────────────────────────────────

  function downloadTemplate() {
    const templateData = [
      {
        Name: "Jane Smith",
        Email: "jane@example.com",
        Role: "staff",
        Department: departments[0]?.name || "Kitchen",
        "Employment Type": "full_time",
      },
      {
        Name: "John Doe",
        Email: "john@example.com",
        Role: "manager",
        Department: departments[1]?.name || "Bar",
        "Employment Type": "casual",
      },
    ];

    const ws = XLSX.utils.json_to_sheet(templateData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Members");

    // Set column widths
    ws["!cols"] = [
      { wch: 20 }, // Name
      { wch: 25 }, // Email
      { wch: 10 }, // Role
      { wch: 20 }, // Department
      { wch: 18 }, // Employment Type
    ];

    XLSX.writeFile(wb, "member-import-template.xlsx");
  }

  // ─── Row editing ────────────────────────────────────────────

  function rowStatus(row: ImportRow): ImportRow["status"] {
    if (Object.keys(row.errors).length > 0) return "error";
    return row.corrections.length > 0 ? "corrected" : "valid";
  }

  /**
   * Recomputes "Duplicate in file" across the whole list.
   *
   * In-file duplicates are a property of the set, not of one row, so they can't
   * be re-derived from the edited row alone: the first occurrence wins and
   * every later one is flagged, which means editing row 3 can clear row 7's
   * error or create one on row 9. updateRow only checked the row being typed
   * into, so a fixed row could quietly leave a real duplicate marked valid and
   * the import went ahead with both.
   */
  function applyDuplicateEmailErrors(list: ImportRow[]): ImportRow[] {
    const seen = new Set<string>();

    return list.map((row) => {
      const email = row.email.toLowerCase().trim();
      const errors = { ...row.errors };

      // Only owned by this pass — leave "required"/"format"/"already a member"
      // alone, since those are decided per row.
      if (errors.email === "Duplicate in file") delete errors.email;

      if (email && !errors.email) {
        if (seen.has(email)) errors.email = "Duplicate in file";
        else seen.add(email);
      }

      const updated = { ...row, errors };
      return { ...updated, status: rowStatus(updated) };
    });
  }

  function updateRow(rowNum: number, field: keyof ImportRow, value: string) {
    setRows((prev) => {
      const next = prev.map((row) => {
        if (row.rowNum !== rowNum) return row;

        const updated = { ...row, [field]: value };

        // Re-validate the changed field
        const newErrors = { ...row.errors };

        if (field === "name") {
          if (!value.trim()) newErrors.name = "Name is required";
          else if (value.trim().length < 2)
            newErrors.name = "Min 2 characters required";
          else delete newErrors.name;
        }

        if (field === "email") {
          const email = value.toLowerCase().trim();
          if (!email) newErrors.email = "Email is required";
          else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            newErrors.email = "Invalid email format";
          else if (existingEmails.has(email))
            newErrors.email = "Already a member";
          else delete newErrors.email;
          // In-file duplicates are settled by the pass below.
        }

        if (field === "department") {
          // Parsing resolves aliases and near-misses through matchDepartment;
          // re-validating with an exact name comparison rejected values that
          // the parser itself had produced.
          const deptMatch = matchDepartment(value);
          if (deptMatch.matched) {
            updated.department = deptMatch.name;
            delete newErrors.department;
          } else {
            newErrors.department = `"${value}" not found`;
          }
        }

        if (field === "role") delete newErrors.role;
        if (field === "employmentType") delete newErrors.employmentType;

        updated.errors = newErrors;
        updated.status = rowStatus(updated);

        return updated;
      });

      return applyDuplicateEmailErrors(next);
    });
  }

  function toggleSkip(rowNum: number) {
    setRows((prev) =>
      prev.map((row) =>
        row.rowNum === rowNum ? { ...row, skipped: !row.skipped } : row
      )
    );
  }

  // ─── Import ─────────────────────────────────────────────────

  async function handleImport() {
    const toImport = rows.filter((r) => !r.skipped && r.status !== "error");

    if (toImport.length === 0) {
      setError("No valid rows to import");
      return;
    }

    // Check member limit
    if (memberLimit !== null) {
      const totalAfter = currentMemberCount + toImport.length;
      if (totalAfter > memberLimit) {
        setError(
          `Import would exceed member limit. ` +
          `Current: ${currentMemberCount}, importing: ${toImport.length}, ` +
          `limit: ${memberLimit}. Remove some rows or upgrade your plan.`
        );
        return;
      }
    }

    setPhase("importing");

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/members/import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            members: toImport.map((r) => ({
              name: r.name.trim(),
              email: r.email.toLowerCase().trim(),
              role: r.role,
              departmentName: r.department || null,
              employmentType: r.employmentType,
            })),
          }),
        }
      );

      const result = await res.json();

      if (!res.ok) {
        setError(apiErrorMessage(result, "Import failed"));
        setPhase("preview");
        return;
      }

      setImportResults(result);
      setPhase("complete");
    } catch {
      setError("Something went wrong during import");
      setPhase("preview");
    }
  }

  // ─── Computed values ────────────────────────────────────────

  const validCount = rows.filter(
    (r) => !r.skipped && r.status === "valid"
  ).length;
  const correctedCount = rows.filter(
    (r) => !r.skipped && r.status === "corrected"
  ).length;
  const errorCount = rows.filter(
    (r) => !r.skipped && r.status === "error"
  ).length;
  const importableCount = validCount + correctedCount;
  const skippedCount = rows.filter((r) => r.skipped).length;

  // ─── Render helpers ─────────────────────────────────────────

  function correctionFor(row: ImportRow, field: string): Correction | undefined {
    return row.corrections.find((c) => c.field === field);
  }

  function rowBgClass(row: ImportRow): string {
    if (row.skipped) return "opacity-40";
    if (row.status === "error")
      return "bg-red-50 dark:bg-red-950/30";
    if (row.status === "corrected")
      return "bg-amber-50 dark:bg-amber-950/30";
    return "";
  }

  // ─── Render ─────────────────────────────────────────────────

  /*
   * Below every hook, deliberately. A guard placed above them would make each
   * `useState` and `useEffect` in this file conditional, which React forbids —
   * the same mistake the other gated pages were corrected for.
   *
   * `members:invite` is what `POST /members/import` enforces. Without this the
   * page offered the whole upload-and-map flow to anyone who typed the URL,
   * and refused only at the final step, after the work of mapping columns.
   */
  if (!can("members:invite")) {
    return (
      <EmptyState
        icon={Lock}
        title="You don't have access to member import"
        description="Importing members requires the Invite members permission. Ask a company admin if you need it."
      />
    );
  }

  /*
   * The plan, checked here rather than at submit.
   *
   * `POST /members/import` refuses without `mass_import` and always has. The
   * page did not, so a Free organisation could upload a spreadsheet, map every
   * column, review a validated preview of a hundred rows, and be told at the
   * final button that the feature needs Pro. The enforcement was right and the
   * order was wrong — the whole cost of the feature was spent before the
   * refusal.
   *
   * After the permission check, for the same reason as the Roles page: somebody
   * who cannot invite members at all should be told that, not offered a plan.
   */
  if (!plan.has("mass_import")) {
    return (
      <PlanLocked
        feature="mass_import"
        title="Bulk imports"
        description="They add a whole team from one spreadsheet instead of inviting people one at a time."
        orgId={orgId}
      />
    );
  }

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Import Members</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Bulk import staff and managers from an Excel or CSV file
          </p>
        </div>
        <button
          onClick={() => router.push(`/org/${orgId}/members`)}
          className="rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          ← Back to Members
        </button>
      </div>

      {error && <AlertBanner message={error} variant="error" />}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/*  Upload Phase                                              */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {phase === "upload" && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Upload File</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Upload an Excel (.xlsx) or CSV file with your team data
            </p>
          </div>
          <div className="p-4 space-y-4">
            {/* Drag-drop zone */}
            <div
              className={`
                rounded-xl border-2 border-dashed p-8 sm:p-12 text-center
                transition-all duration-200
                ${!referenceReady
                  ? "cursor-wait border-border opacity-60"
                  : dragActive
                    ? "cursor-pointer border-indigo-400 bg-indigo-50/50 dark:bg-indigo-950/20"
                    : "cursor-pointer border-border hover:border-indigo-300 hover:bg-muted/30 dark:hover:border-indigo-800"
                }
              `}
              onDragEnter={referenceReady ? handleDrag : undefined}
              onDragLeave={referenceReady ? handleDrag : undefined}
              onDragOver={referenceReady ? handleDrag : undefined}
              onDrop={handleDrop}
              onClick={() => { if (referenceReady) fileInputRef.current?.click(); }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                disabled={!referenceReady}
                onChange={handleFileSelect}
                className="hidden"
              />
              {/* Upload icon */}
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-100 dark:bg-indigo-900/30">
                <Upload className="h-6 w-6 text-indigo-600 dark:text-indigo-400" strokeWidth={1.5} aria-hidden="true" />
              </div>
              {referenceReady ? (
                <>
                  <p className="text-sm font-medium text-foreground">
                    Drag and drop your file here, or{" "}
                    <span className="text-indigo-600 dark:text-indigo-400 underline underline-offset-2">browse</span>
                  </p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Supports .xlsx, .xls, and .csv — max 200 rows, 5 MB
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-muted-foreground">
                    Loading your departments and members…
                  </p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Uploads are held until then so rows are checked against real data
                  </p>
                </>
              )}
            </div>

            {/* Bottom bar: template + slot counter */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <button
                onClick={downloadTemplate}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-indigo-400 hover:text-foreground"
              >
                <Download className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                Download Template
              </button>
              <p className="text-xs text-muted-foreground">
                {memberLimit !== null
                  ? `${currentMemberCount} of ${memberLimit} member slots used`
                  : `${currentMemberCount} members`}
              </p>
            </div>

            {/* Expected columns hint */}
            <div className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground text-xs mb-1">Expected columns</p>
              <p>
                Name (required), Email (required), Role (staff or manager — defaults to staff),
                Department (must match existing), Employment Type (full_time or casual — defaults to casual)
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/*  Preview Phase                                             */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {phase === "preview" && (
        <>
          {/* Stat tiles */}
          <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
            <StatTile label="Ready" value={validCount} detail="valid rows" accentColour="rgba(34,197,94,.08)" valueColour="text-green-600 dark:text-green-400" />
            <StatTile label="Corrected" value={correctedCount} detail="auto-fixed" accentColour="rgba(245,158,11,.08)" valueColour={correctedCount > 0 ? "text-amber-600 dark:text-amber-400" : ""} />
            <StatTile label="Errors" value={errorCount} detail="fix or skip" accentColour="rgba(239,68,68,.08)" valueColour={errorCount > 0 ? "text-red-500 dark:text-red-400" : ""} />
            <StatTile label="Skipped" value={skippedCount} detail="excluded" accentColour="rgba(148,163,184,.08)" />
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {/* Card header */}
            <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold">Import Preview</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">{fileName} — {rows.length} rows parsed</p>
              </div>
              {/* Status badges */}
              <div className="flex flex-wrap gap-1.5">
                <span className="inline-flex items-center gap-1 rounded-md bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700 dark:bg-green-900/50 dark:text-green-300">
                  {validCount} ready
                </span>
                {correctedCount > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
                    {correctedCount} corrected
                  </span>
                )}
                {errorCount > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/50 dark:text-red-300">
                    {errorCount} errors
                  </span>
                )}
                {skippedCount > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                    {skippedCount} skipped
                  </span>
                )}
              </div>
            </div>

            <div className="p-4 space-y-3">
              {/* Legend */}
              <div className="flex flex-wrap gap-4 text-xs text-muted-foreground border-b border-border/50 pb-3">
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm bg-green-200 dark:bg-green-800" />
                  Ready to import
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm bg-amber-200 dark:bg-amber-800" />
                  Auto-corrected — review
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm bg-red-200 dark:bg-red-800" />
                  Error — fix or skip
                </div>
              </div>

              {/* Column mapping banner */}
              {columnMappings.some((m) => m.method === "alias" || m.method === "ai") && (
                <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 p-2.5 text-xs text-blue-700 dark:text-blue-300">
                  <span className="font-semibold">Column mapping: </span>
                  {columnMappings
                    .filter((m) => m.method !== "exact")
                    .map((m, i) => (
                      <span key={m.source}>
                        {i > 0 && ", "}
                        &quot;{m.source}&quot; → {m.target}
                      </span>
                    ))}
                </div>
              )}

              {/* Preview table */}
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground w-10">#</th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Name</th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Email</th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground w-28">Role</th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Department</th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground w-28">Type</th>
                      <th className="px-3 py-2.5 text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.rowNum}
                        className={`border-b border-border last:border-0 transition-colors ${rowBgClass(row)}`}
                      >
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {row.rowNum}
                        </td>

                        {/* Name */}
                        <td className="px-3 py-2">
                          {row.errors.name || row.status === "error" ? (
                            <div>
                              <Input
                                value={row.name}
                                onChange={(e) =>
                                  updateRow(row.rowNum, "name", e.target.value)
                                }
                                className={`h-7 text-sm ${
                                  row.errors.name
                                    ? "border-red-400 dark:border-red-600"
                                    : ""
                                }`}
                              />
                              {row.errors.name && (
                                <p className="text-xs text-red-500 mt-0.5">
                                  {row.errors.name}
                                </p>
                              )}
                            </div>
                          ) : (
                            <span className="text-sm">{row.name}</span>
                          )}
                        </td>

                        {/* Email */}
                        <td className="px-3 py-2">
                          {row.errors.email || row.status === "error" ? (
                            <div>
                              <Input
                                value={row.email}
                                onChange={(e) =>
                                  updateRow(row.rowNum, "email", e.target.value)
                                }
                                className={`h-7 text-sm ${
                                  row.errors.email
                                    ? "border-red-400 dark:border-red-600"
                                    : ""
                                }`}
                              />
                              {row.errors.email && (
                                <p className="text-xs text-red-500 mt-0.5">
                                  {row.errors.email}
                                </p>
                              )}
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground">{row.email}</span>
                          )}
                        </td>

                        {/* Role */}
                        <td className="px-3 py-2">
                          {correctionFor(row, "role") || row.status === "error" ? (
                            <div>
                              {correctionFor(row, "role") && (
                                <span className="text-xs line-through text-muted-foreground mr-1">
                                  {correctionFor(row, "role")!.from}
                                </span>
                              )}
                              <select
                                className="w-full rounded-lg border border-border bg-background px-2 py-1 text-xs"
                                value={row.role}
                                onChange={(e) =>
                                  updateRow(row.rowNum, "role", e.target.value)
                                }
                              >
                                {INVITABLE_ROLES.map((r) => (
                                  <option key={r} value={r}>
                                    {ROLE_DISPLAY[r]}
                                  </option>
                                ))}
                              </select>
                            </div>
                          ) : (
                            <span className="text-sm">{ROLE_DISPLAY[row.role] || row.role}</span>
                          )}
                        </td>

                        {/* Department */}
                        <td className="px-3 py-2">
                          {correctionFor(row, "department") ||
                          row.errors.department ||
                          row.status === "error" ? (
                            <div>
                              {correctionFor(row, "department") && (
                                <span className="text-xs line-through text-muted-foreground mr-1">
                                  {correctionFor(row, "department")!.from}
                                </span>
                              )}
                              <select
                                className={`w-full rounded-lg border bg-background px-2 py-1 text-xs ${
                                  row.errors.department
                                    ? "border-red-400 dark:border-red-600"
                                    : "border-border"
                                }`}
                                value={row.department}
                                onChange={(e) =>
                                  updateRow(row.rowNum, "department", e.target.value)
                                }
                              >
                                <option value="">No department</option>
                                {departments.map((d) => (
                                  <option key={d.id} value={d.name}>
                                    {d.name}
                                  </option>
                                ))}
                              </select>
                              {row.errors.department && (
                                <p className="text-xs text-red-500 mt-0.5">
                                  {row.errors.department}
                                </p>
                              )}
                            </div>
                          ) : (
                            <span className="text-sm">
                              {row.department || (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </span>
                          )}
                        </td>

                        {/* Employment Type */}
                        <td className="px-3 py-2">
                          {correctionFor(row, "employmentType") ||
                          row.status === "error" ? (
                            <div>
                              {correctionFor(row, "employmentType") && (
                                <span className="text-xs line-through text-muted-foreground mr-1">
                                  {correctionFor(row, "employmentType")!.from}
                                </span>
                              )}
                              <select
                                className="w-full rounded-lg border border-border bg-background px-2 py-1 text-xs"
                                value={row.employmentType}
                                onChange={(e) =>
                                  updateRow(
                                    row.rowNum,
                                    "employmentType",
                                    e.target.value
                                  )
                                }
                              >
                                {EMPLOYMENT_TYPES.map((t) => (
                                  <option key={t} value={t}>
                                    {EMPLOYMENT_DISPLAY[t]}
                                  </option>
                                ))}
                              </select>
                            </div>
                          ) : (
                            <span className="text-sm">
                              {EMPLOYMENT_DISPLAY[row.employmentType] ||
                              row.employmentType}
                            </span>
                          )}
                        </td>

                        {/* Status / actions */}
                        <td className="px-3 py-2 text-center">
                          {row.skipped ? (
                            <button
                              className="text-xs text-indigo-600 dark:text-indigo-400 underline underline-offset-2 font-medium"
                              onClick={() => toggleSkip(row.rowNum)}
                            >
                              undo
                            </button>
                          ) : (
                            <div className="flex flex-col items-center gap-1">
                              {row.status === "valid" && (
                                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-green-100 text-xs font-bold text-green-700 dark:bg-green-900/50 dark:text-green-300">
                                  ✓
                                </span>
                              )}
                              {row.status === "corrected" && (
                                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-100 text-xs font-bold text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
                                  ✦
                                </span>
                              )}
                              {row.status === "error" && (
                                <>
                                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-100 text-xs font-bold text-red-700 dark:bg-red-900/50 dark:text-red-300">
                                    !
                                  </span>
                                  <button
                                    className="text-xs text-muted-foreground underline underline-offset-2"
                                    onClick={() => toggleSkip(row.rowNum)}
                                  >
                                    skip
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Footer actions */}
              <div className="flex flex-col gap-2 border-t border-border/50 pt-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
                  {memberLimit !== null
                    ? `${currentMemberCount} of ${memberLimit} member slots used — importing ${importableCount}`
                    : `${currentMemberCount} current members — importing ${importableCount}`}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setPhase("upload");
                      setRows([]);
                      setColumnMappings([]);
                      setFileName("");
                      setError(null);
                    }}
                    className="rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleImport}
                    disabled={importableCount === 0}
                    className={PRIMARY_BUTTON}
                  >
                    Import {importableCount} member{importableCount !== 1 ? "s" : ""}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/*  Importing Phase                                           */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {phase === "importing" && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex flex-col items-center justify-center py-16 text-center">
            {/* Spinner */}
            <div className="mb-4 h-8 w-8 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
            <p className="text-sm font-medium text-foreground">
              Importing {importableCount} members…
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Sending invitations and creating accounts
            </p>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/*  Complete Phase                                            */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {phase === "complete" && importResults && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Import Complete</h3>
          </div>
          <div className="p-4 space-y-4">
            {/* Result tiles */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30 p-5 text-center">
                <p className="text-3xl font-bold text-green-700 dark:text-green-300">
                  {importResults.created}
                </p>
                <p className="mt-1 text-sm font-medium text-green-600 dark:text-green-400">
                  members created
                </p>
              </div>
              {importResults.failed > 0 && (
                <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-5 text-center">
                  <p className="text-3xl font-bold text-red-700 dark:text-red-300">
                    {importResults.failed}
                  </p>
                  <p className="mt-1 text-sm font-medium text-red-600 dark:text-red-400">
                    failed
                  </p>
                </div>
              )}
            </div>

            {importResults.errors.length > 0 && (
              <div className="rounded-lg bg-red-50 dark:bg-red-950/20 p-3 space-y-1">
                <p className="text-xs font-semibold text-red-700 dark:text-red-400">Errors</p>
                {importResults.errors.map((err, i) => (
                  <p key={i} className="text-xs text-red-600 dark:text-red-400">
                    {err}
                  </p>
                ))}
              </div>
            )}

            <button
              onClick={() => router.push(`/org/${orgId}/members`)}
              className={PRIMARY_BUTTON}
            >
              Back to Members
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
