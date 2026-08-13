/**
 * Bulk Invite Dialog (Boundary Layer)
 *
 * Upload a spreadsheet of people and invite all of them.
 *
 * ## The format is stated before the upload, not after
 *
 * The dialog opens on the column spec and a template download, and the file
 * picker sits underneath it. That ordering is the whole point: an import that
 * explains its format only by rejecting your file teaches you the rules one
 * failure at a time, and the person uploading is usually working from an HR
 * export they did not write and cannot easily reshape.
 *
 * ## Three steps, and why the middle one is not optional
 *
 *   spec → preview → result
 *
 * The preview cannot be skipped. Sending is the irreversible half — every
 * invitation is an email to a real person — and the resolver GUESSES: it reads
 * "F/T" as full-time and may read "Frontof House" as Front of House. Those
 * guesses are shown as notes on the row they affect, so the reader confirms
 * what will actually happen rather than what they meant to upload.
 *
 * Parsing happens here, in the browser, because SheetJS is already in the
 * bundle for the member import. Everything after parsing happens on the server,
 * because that is where the AI keys and every permission check live.
 */
"use client";

import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import { AlertTriangle, Check, Download, Upload, X } from "lucide-react";
import { INVITE_COLUMNS } from "@/lib/import-config";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/components/ui/button-styles";
import { AlertBanner } from "@/components/ui/alert-banner";
import { apiErrorMessage } from "@/lib/api-error";

interface ResolvedRow {
  rowNumber: number;
  email: string;
  role: string;
  departmentId: string | null;
  departmentName: string | null;
  employmentType: string;
  errors: string[];
  notes: string[];
}

interface BulkInviteDialogProps {
  orgId: string;
  onClose: () => void;
  /** Called after a send that created at least one invitation. */
  onSent: () => void;
}

type Step = "spec" | "preview" | "result";

/** Rows the file may contain before we refuse to read it at all. */
const MAX_ROWS = 500;

export function BulkInviteDialog({
  orgId,
  onClose,
  onSent,
}: BulkInviteDialogProps) {
  const [step, setStep] = useState<Step>("spec");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<ResolvedRow[]>([]);
  const [unmappedHeaders, setUnmappedHeaders] = useState<string[]>([]);
  const [usedAi, setUsedAi] = useState(false);
  const [result, setResult] = useState<{
    sent: string[];
    failed: { email: string; reason: string }[];
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const validRows = rows.filter((r) => r.errors.length === 0);

  /**
   * A file with the right headers and one example row.
   *
   * Offered because "must match an existing department" is far easier to obey
   * with a starting point than a paragraph, and because the commonest reason an
   * import fails is a header we do not recognise — which a template removes
   * entirely.
   */
  function downloadTemplate() {
    const sheet = XLSX.utils.aoa_to_sheet([
      INVITE_COLUMNS.map((c) => c.label),
      ["someone@example.com", "Staff", "", "Casual"],
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Invitations");
    XLSX.writeFile(book, "shifthappens-invite-template.xlsx");
  }

  async function onFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    setBusy(true);
    setFileName(file.name);

    try {
      const book = XLSX.read(await file.arrayBuffer());
      const sheet = book.Sheets[book.SheetNames[0]];
      if (!sheet) {
        setError("That file has no sheets in it.");
        return;
      }

      /*
       * `defval: ""` so a blank cell arrives as an empty string rather than a
       * missing key — otherwise a row whose Department is blank has a
       * different SHAPE from one that fills it in, and the resolver reads
       * columns positionally off the first row's keys.
       *
       * `raw: false` so everything arrives as text. Without it a department
       * called "2024" comes through as a number and a phone-shaped value is
       * reformatted by SheetJS before we ever see it.
       */
      const raw = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, {
        defval: "",
        raw: false,
      });

      if (raw.length === 0) {
        setError("That file has no rows under its headers.");
        return;
      }
      if (raw.length > MAX_ROWS) {
        setError(
          `That file has ${raw.length} rows. Import at most ${MAX_ROWS} at a time.`
        );
        return;
      }

      const res = await fetch(`/api/organizations/${orgId}/invitations/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: raw }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(apiErrorMessage(body, "Could not read that file"));
        return;
      }

      setRows(body.rows ?? []);
      setUnmappedHeaders(body.unmappedHeaders ?? []);
      setUsedAi(Boolean(body.usedAi));
      setStep("preview");
    } catch {
      setError("Could not read that file. Is it a .xlsx or .csv?");
    } finally {
      setBusy(false);
      // Cleared so choosing the SAME file again still fires a change event.
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function send() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/invitations/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: validRows.map((r) => ({
            email: r.email,
            role: r.role,
            ...(r.departmentId ? { departmentId: r.departmentId } : {}),
            employmentType: r.employmentType,
          })),
        }),
      });
      const body = await res.json().catch(() => ({}));

      // 207 is a partial send: some invitations went out. It is not `res.ok`,
      // and treating it as a failure would hide the ones that succeeded.
      if (!res.ok && res.status !== 207) {
        setError(apiErrorMessage(body, "Could not send the invitations"));
        return;
      }

      setResult({ sent: body.sent ?? [], failed: body.failed ?? [] });
      setStep("result");
      if ((body.sent ?? []).length > 0) onSent();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-invite-title"
    >
      <div className="w-full max-w-3xl rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between border-b border-border p-4">
          <div>
            <h2 id="bulk-invite-title" className="text-base font-semibold">
              Invite from a spreadsheet
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {step === "spec" && "Upload an .xlsx or .csv of people to invite."}
              {step === "preview" && fileName}
              {step === "result" && "Finished."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="max-h-[65vh] overflow-y-auto p-4">
          {error && (
            <AlertBanner message={error} variant="error" className="mb-4" />
          )}

          {step === "spec" && (
            <>
              <p className="text-sm font-medium">
                Your first row must be the column headings
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Only <strong>Email</strong> is required. Common variations are
                understood — &ldquo;E-mail&rdquo;, &ldquo;Dept&rdquo;,
                &ldquo;Full-time&rdquo; — and anything left blank takes its
                default. Extra columns are ignored.
              </p>

              <div className="mt-3 overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Column
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Accepts
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {INVITE_COLUMNS.map((column) => (
                      <tr
                        key={column.key}
                        className="border-b border-border last:border-b-0"
                      >
                        <td className="whitespace-nowrap px-3 py-2 align-top">
                          <span className="font-medium">{column.label}</span>
                          {column.required && (
                            <span className="ml-1.5 rounded-full bg-destructive/10 px-1.5 py-px text-[10px] font-semibold uppercase text-destructive">
                              Required
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {column.description}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={downloadTemplate}
                  className={SECONDARY_BUTTON}
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  Download template
                </button>
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  disabled={busy}
                  className={PRIMARY_BUTTON}
                >
                  <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                  {busy ? "Reading…" : "Choose file"}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={onFileChosen}
                  className="hidden"
                />
              </div>
            </>
          )}

          {step === "preview" && (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">
                  {validRows.length} of {rows.length} rows ready
                </span>
                {rows.length > validRows.length && (
                  <span className="rounded-full bg-destructive/10 px-2 py-px text-xs font-semibold text-destructive">
                    {rows.length - validRows.length} cannot be sent
                  </span>
                )}
                {usedAi && (
                  <span className="rounded-full bg-indigo-100 px-2 py-px text-xs font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                    AI resolved some values
                  </span>
                )}
              </div>

              {unmappedHeaders.length > 0 && (
                <p className="mb-3 text-xs text-muted-foreground">
                  Ignored columns: {unmappedHeaders.join(", ")}
                </p>
              )}

              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Row
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Email
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Role
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Department
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Type
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const broken = row.errors.length > 0;
                      return (
                        <tr
                          key={row.rowNumber}
                          className={`border-b border-border last:border-b-0 ${
                            broken ? "bg-destructive/5" : ""
                          }`}
                        >
                          <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                            {row.rowNumber}
                          </td>
                          <td className="px-3 py-2 align-top">
                            <span className={broken ? "text-destructive" : ""}>
                              {row.email || "—"}
                            </span>
                            {row.errors.map((message) => (
                              <p
                                key={message}
                                className="mt-0.5 flex items-start gap-1 text-xs text-destructive"
                              >
                                <AlertTriangle
                                  className="mt-px h-3 w-3 shrink-0"
                                  aria-hidden="true"
                                />
                                {message}
                              </p>
                            ))}
                            {!broken &&
                              row.notes.map((message) => (
                                <p
                                  key={message}
                                  className="mt-0.5 text-xs text-muted-foreground"
                                >
                                  {message}
                                </p>
                              ))}
                          </td>
                          <td className="px-3 py-2 align-top text-xs">
                            {row.role}
                          </td>
                          <td className="px-3 py-2 align-top text-xs">
                            {row.departmentName || "—"}
                          </td>
                          <td className="px-3 py-2 align-top text-xs">
                            {row.employmentType}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {step === "result" && result && (
            <>
              {result.sent.length > 0 && (
                <p className="flex items-center gap-1.5 text-sm font-medium text-green-700 dark:text-green-400">
                  <Check className="h-4 w-4" aria-hidden="true" />
                  {result.sent.length} invitation
                  {result.sent.length === 1 ? "" : "s"} sent
                </p>
              )}
              {result.failed.length > 0 && (
                <div className="mt-3">
                  <p className="text-sm font-medium text-destructive">
                    {result.failed.length} could not be sent
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {result.failed.map((failure) => (
                      <li key={failure.email} className="text-xs">
                        <span className="font-medium">{failure.email}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          — {failure.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {/*
                    Named individually rather than summarised. "3 failed" sends
                    somebody back to a spreadsheet to work out which three, and
                    the reasons are per-address facts — already a member, seat
                    limit reached — that no summary can carry.
                  */}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border p-4">
          <button
            type="button"
            onClick={step === "preview" ? () => setStep("spec") : onClose}
            className={SECONDARY_BUTTON}
          >
            {step === "preview" ? "Back" : "Close"}
          </button>

          {step === "preview" && (
            <button
              type="button"
              onClick={send}
              disabled={busy || validRows.length === 0}
              className={PRIMARY_BUTTON}
            >
              {busy
                ? "Sending…"
                : `Send ${validRows.length} invitation${
                    validRows.length === 1 ? "" : "s"
                  }`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
