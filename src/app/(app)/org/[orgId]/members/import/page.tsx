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
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AlertBanner } from "@/components/ui/alert-banner";
import * as XLSX from "xlsx";
import {
  SYSTEM_ROLE_LABELS,
  EMPLOYMENT_TYPE_LABELS,
} from "@/lib/role-config";

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

// ─── Constants ────────────────────────────────────────────────

const INVITABLE_ROLES = ["staff", "manager"];
const EMPLOYMENT_TYPES = ["full_time", "casual"];

const ROLE_DISPLAY: Record<string, string> = {
  staff: SYSTEM_ROLE_LABELS.staff || "Staff",
  manager: SYSTEM_ROLE_LABELS.manager || "Manager",
};

const EMPLOYMENT_DISPLAY: Record<string, string> = {
  full_time: EMPLOYMENT_TYPE_LABELS.full_time || "Full-time",
  casual: EMPLOYMENT_TYPE_LABELS.casual || "Casual",
};

/** Header aliases for algorithmic column mapping fallback */
const HEADER_ALIASES: Record<string, string[]> = {
  name: ["name", "full name", "employee name", "staff name", "member name", "first name"],
  email: ["email", "e-mail", "email address", "mail"],
  role: ["role", "position", "job title", "type"],
  department: ["department", "dept", "team", "section", "unit"],
  employmentType: [
    "employment type", "work type", "contract type", "emp type",
    "employment", "contract", "status",
  ],
};

/** Map common role variations to system values */
const ROLE_ALIASES: Record<string, string> = {
  staff: "staff",
  employee: "staff",
  worker: "staff",
  team_member: "staff",
  "team member": "staff",
  manager: "manager",
  supervisor: "manager",
  lead: "manager",
  "team lead": "manager",
};

/** Map common employment type variations to system values */
const EMPLOYMENT_ALIASES: Record<string, string> = {
  full_time: "full_time",
  fulltime: "full_time",
  "full-time": "full_time",
  "full time": "full_time",
  permanent: "full_time",
  casual: "casual",
  "part-time": "casual",
  "part time": "casual",
  parttime: "casual",
  temporary: "casual",
  contract: "casual",
  temp: "casual",
};

// ─── Component ────────────────────────────────────────────────

export default function MemberImportPage() {
  const params = useParams();
  const router = useRouter();
  const orgId = params.orgId as string;
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── State ──────────────────────────────────────────────────
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

  // ─── Data fetching ──────────────────────────────────────────
  useEffect(() => {
    fetchDepartments();
    fetchSubscription();
    fetchExistingMembers();
  }, [orgId]);

  async function fetchDepartments() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/departments`);
      if (res.ok) {
        const data = await res.json();
        setDepartments(data);
      }
    } catch {
      // Non-critical — departments list may be empty
    }
  }

  async function fetchSubscription() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/subscription`);
      if (res.ok) {
        const data = await res.json();
        setMemberLimit(data.resources?.members?.limit ?? null);
        setCurrentMemberCount(data.resources?.members?.current ?? 0);
      }
    } catch {
      // Non-critical
    }
  }

  async function fetchExistingMembers() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/members`);
      if (res.ok) {
        const data = await res.json();
        const emails = new Set<string>(
          data.map((m: { user: { email: string } }) => m.user.email.toLowerCase())
        );
        setExistingEmails(emails);
      }
    } catch {
      // Non-critical
    }
  }

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
    if (!value.trim()) return { name: "", matched: true };

    // Exact match
    const exact = departments.find(
      (d) => d.name.toLowerCase() === value.toLowerCase().trim()
    );
    if (exact) return { name: exact.name, matched: true };

    // Partial match (contains)
    const partial = departments.find(
      (d) =>
        d.name.toLowerCase().includes(value.toLowerCase().trim()) ||
        value.toLowerCase().trim().includes(d.name.toLowerCase())
    );
    if (partial) return { name: partial.name, matched: true };

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
      let name = rawName;
      if (!name) {
        errors.name = "Name is required";
      } else if (name.length < 2) {
        errors.name = "Min 2 characters required";
      }

      // ── Email validation ──
      let email = rawEmail.toLowerCase();
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
  }, [departments, existingEmails]);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files[0]) {
        processFile(e.target.files[0]);
      }
    },
    [departments, existingEmails]
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

  function updateRow(rowNum: number, field: keyof ImportRow, value: string) {
    setRows((prev) =>
      prev.map((row) => {
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
        }

        if (field === "department") {
          if (value && !departments.some((d) => d.name === value)) {
            newErrors.department = `"${value}" not found`;
          } else {
            delete newErrors.department;
          }
        }

        if (field === "role") delete newErrors.role;
        if (field === "employmentType") delete newErrors.employmentType;

        updated.errors = newErrors;
        updated.status =
          Object.keys(newErrors).length > 0
            ? "error"
            : updated.corrections.length > 0
              ? "corrected"
              : "valid";

        return updated;
      })
    );
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
        setError(result.error || "Import failed");
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

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Import members</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Bulk import staff and managers from an Excel or CSV file
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => router.push(`/org/${orgId}/members`)}
        >
          Back to members
        </Button>
      </div>

      {error && <AlertBanner message={error} variant="error" />}

      {/* ─── Upload Phase ──────────────────────────────────────── */}
      {phase === "upload" && (
        <Card>
          <CardHeader>
            <CardTitle>Upload file</CardTitle>
            <CardDescription>
              Upload an Excel (.xlsx) or CSV file with your team data.
              Download the template for the expected format.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              className={`
                border-2 border-dashed rounded-lg p-10 text-center cursor-pointer
                transition-colors
                ${
                  dragActive
                    ? "border-primary bg-primary/5"
                    : "border-muted-foreground/25 hover:border-muted-foreground/50"
                }
              `}
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileSelect}
                className="hidden"
              />
              <p className="text-muted-foreground">
                Drag and drop your file here, or click to browse
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                Supports .xlsx, .xls, and .csv — max 200 rows, 5 MB
              </p>
            </div>

            <div className="flex items-center justify-between">
              <Button variant="outline" size="sm" onClick={downloadTemplate}>
                Download template
              </Button>
              <p className="text-xs text-muted-foreground">
                {memberLimit !== null
                  ? `${currentMemberCount} of ${memberLimit} member slots used`
                  : `${currentMemberCount} members`}
              </p>
            </div>

            <div className="text-xs text-muted-foreground space-y-1 pt-2">
              <p className="font-medium">Expected columns:</p>
              <p>
                Name (required), Email (required), Role (staff or manager — defaults to staff),
                Department (must match existing), Employment Type (full_time or casual — defaults to casual)
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Preview Phase ─────────────────────────────────────── */}
      {phase === "preview" && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Import preview</CardTitle>
                <CardDescription>{fileName} — {rows.length} rows parsed</CardDescription>
              </div>
              <div className="flex gap-2">
                <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 font-medium">
                  {validCount} ready
                </span>
                {correctedCount > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300 font-medium">
                    {correctedCount} auto-corrected
                  </span>
                )}
                {errorCount > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300 font-medium">
                    {errorCount} errors
                  </span>
                )}
                {skippedCount > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 font-medium">
                    {skippedCount} skipped
                  </span>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Legend */}
            <div className="flex gap-6 text-xs text-muted-foreground pb-2 border-b">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm bg-green-100 dark:bg-green-900 border border-green-200 dark:border-green-800" />
                Ready to import
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm bg-amber-100 dark:bg-amber-900 border border-amber-200 dark:border-amber-800" />
                Auto-corrected — review changes
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm bg-red-100 dark:bg-red-900 border border-red-200 dark:border-red-800" />
                Error — fix or skip row
              </div>
            </div>

            {/* Column mapping banner */}
            {columnMappings.some((m) => m.method === "alias" || m.method === "ai") && (
              <div className="rounded-md p-3 text-xs bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                <span className="font-medium">Column mapping: </span>
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
            <div className="overflow-x-auto border rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground w-10">#</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Name</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Email</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground w-28">Role</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Department</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground w-28">Emp. type</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground w-16" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.rowNum}
                      className={`border-b last:border-0 ${rowBgClass(row)}`}
                    >
                      <td className="px-3 py-2 text-muted-foreground text-xs">
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
                              <p className="text-xs text-red-500 mt-1">
                                {row.errors.name}
                              </p>
                            )}
                          </div>
                        ) : (
                          row.name
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
                              <p className="text-xs text-red-500 mt-1">
                                {row.errors.email}
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">{row.email}</span>
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
                              className="w-full rounded-md border px-2 py-1 text-sm bg-background"
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
                          ROLE_DISPLAY[row.role] || row.role
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
                              className={`w-full rounded-md border px-2 py-1 text-sm bg-background ${
                                row.errors.department
                                  ? "border-red-400 dark:border-red-600"
                                  : ""
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
                              <p className="text-xs text-red-500 mt-1">
                                {row.errors.department}
                              </p>
                            )}
                          </div>
                        ) : (
                          row.department || (
                            <span className="text-muted-foreground">—</span>
                          )
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
                              className="w-full rounded-md border px-2 py-1 text-sm bg-background"
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
                          EMPLOYMENT_DISPLAY[row.employmentType] ||
                          row.employmentType
                        )}
                      </td>

                      {/* Status / actions */}
                      <td className="px-3 py-2 text-center">
                        {row.skipped ? (
                          <button
                            className="text-xs text-blue-600 dark:text-blue-400 underline"
                            onClick={() => toggleSkip(row.rowNum)}
                          >
                            undo
                          </button>
                        ) : (
                          <div className="flex flex-col items-center gap-1">
                            {row.status === "valid" && (
                              <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
                                ✓
                              </span>
                            )}
                            {row.status === "corrected" && (
                              <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                                ✦
                              </span>
                            )}
                            {row.status === "error" && (
                              <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300">
                                !
                              </span>
                            )}
                            {row.status === "error" && (
                              <button
                                className="text-xs text-muted-foreground underline"
                                onClick={() => toggleSkip(row.rowNum)}
                              >
                                skip
                              </button>
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
            <div className="flex items-center justify-between pt-2">
              <p className="text-xs text-muted-foreground">
                {memberLimit !== null
                  ? `${currentMemberCount} of ${memberLimit} member slots used — importing ${importableCount}`
                  : `${currentMemberCount} current members — importing ${importableCount}`}
              </p>
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  onClick={() => {
                    setPhase("upload");
                    setRows([]);
                    setColumnMappings([]);
                    setFileName("");
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleImport}
                  disabled={importableCount === 0}
                >
                  Import {importableCount} member{importableCount !== 1 ? "s" : ""}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Importing Phase ───────────────────────────────────── */}
      {phase === "importing" && (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              Importing {importableCount} members...
            </p>
          </CardContent>
        </Card>
      )}

      {/* ─── Complete Phase ────────────────────────────────────── */}
      {phase === "complete" && importResults && (
        <Card>
          <CardHeader>
            <CardTitle>Import complete</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-4">
              <div className="rounded-md p-4 bg-green-50 dark:bg-green-950 flex-1 text-center">
                <p className="text-2xl font-bold text-green-700 dark:text-green-300">
                  {importResults.created}
                </p>
                <p className="text-sm text-green-600 dark:text-green-400">
                  members created
                </p>
              </div>
              {importResults.failed > 0 && (
                <div className="rounded-md p-4 bg-red-50 dark:bg-red-950 flex-1 text-center">
                  <p className="text-2xl font-bold text-red-700 dark:text-red-300">
                    {importResults.failed}
                  </p>
                  <p className="text-sm text-red-600 dark:text-red-400">failed</p>
                </div>
              )}
            </div>

            {importResults.errors.length > 0 && (
              <div className="text-sm space-y-1">
                <p className="font-medium">Errors:</p>
                {importResults.errors.map((err, i) => (
                  <p key={i} className="text-red-500 text-xs">
                    {err}
                  </p>
                ))}
              </div>
            )}

            <Button onClick={() => router.push(`/org/${orgId}/members`)}>
              Back to members
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}