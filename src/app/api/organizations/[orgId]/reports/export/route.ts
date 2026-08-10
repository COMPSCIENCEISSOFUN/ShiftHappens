/**
 * PDF Report Export API Route (Boundary Layer)
 *
 * GET /api/organizations/[orgId]/reports/export
 *
 * Generates and returns a weekly workforce briefing PDF.
 *
 * Pro+ and `reports:export`, both enforced by `requirePermission` — the plan
 * first, because it decides which refusal the caller is given. This route used
 * to check the permission and THEN call `enforceFeatureAccess` itself, which
 * inverted that order and answered a Free caller lacking the permission with a
 * bare "Forbidden" instead of the upgrade message. Mapping the permission to
 * `pdf_export` in PERMISSION_FEATURE put one gate in one place; see the note
 * beside that map for what the mapping was previously kept out of it for.
 *
 * Returns: PDF file with Content-Disposition attachment header.
 *
 * BCE compliant: Route (Boundary) → PdfReportService (Control) → ReportingService (Control) → Repository (Entity).
 */
import { NextResponse } from "next/server";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { PdfReportService } from "@/services/pdf-report.service";
import { OrganizationService } from "@/services/organization.service";
import { departmentScopeFor } from "@/lib/department-scope";


export async function GET(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const { orgId } = await params;

    // --- Auth ---
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    // --- Org suspension check ---
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    // --- Plan, then permission. Both live in requirePermission now. ---
    const gate = await requirePermission(user.id, orgId, "reports:export");
    if (!gate.ok) return gate.response;
    const membership = gate.membership;

    // --- Get org name via service (BCE compliant) ---
    const orgService = new OrganizationService();
    const org = await orgService.getOrganization(orgId);
    const orgName = org?.name || "Organization";

    // --- Generate PDF ---
    const pdfReportService = new PdfReportService();
    // Managers see only their departments — same rule as every other report.
    // Without this the PDF was an org-wide staff-hours dump any manager could
    // download and keep.
    /*
     * The export is audited by the SERVICE, not here — `audit-coverage.test.ts`
     * scans `src/services` for every declared action, which encodes the rule
     * that Control raises audit entries and Boundary does not. This route's job
     * is to say who asked.
     */
    const pdfBuffer = await pdfReportService.generateReport(
      orgId,
      orgName,
      departmentScopeFor(membership),
      user.id
    );

    // --- Return PDF as download ---
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    return new Response(pdfBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="workforce-report-${dateStr}.pdf"`,
        "Content-Length": pdfBuffer.byteLength.toString(),
      },
    });
  } catch (error) {
    console.error("PDF export error:", error);
    return NextResponse.json(
      { error: "Failed to generate report" },
      { status: 500 }
    );
  }
}