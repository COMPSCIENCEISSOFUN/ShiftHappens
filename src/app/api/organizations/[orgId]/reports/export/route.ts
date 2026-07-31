/**
 * PDF Report Export API Route (Boundary Layer)
 *
 * GET /api/organizations/[orgId]/reports/export
 *
 * Generates and returns a weekly workforce briefing PDF.
 * Pro+ feature — requires pdf_export subscription feature.
 * Accessible to company_admin and manager roles.
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
import { AccessService } from "@/services/access.service";
import { PdfReportService } from "@/services/pdf-report.service";
import { SubscriptionService } from "@/services/subscription.service";
import { OrganizationService } from "@/services/organization.service";
import { FeatureNotAvailableError } from "@/lib/subscription-tiers";

const accessService = new AccessService();

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

    // --- Membership + role check ---
    const membership = await accessService.getMembership(user.id, orgId);

    if (!membership || !["company_admin", "manager"].includes(membership.role)) {
      return NextResponse.json(
        { error: "Only admins and managers can export reports" },
        { status: 403 }
      );
    }

    // --- Subscription feature gate (Pro+) ---
    const subscriptionService = new SubscriptionService();
    try {
      await subscriptionService.enforceFeatureAccess(orgId, "pdf_export");
    } catch (error) {
      if (error instanceof FeatureNotAvailableError) {
        return NextResponse.json(
          { error: error.message },
          { status: 403 }
        );
      }
      throw error;
    }

    // --- Get org name via service (BCE compliant) ---
    const orgService = new OrganizationService();
    const org = await orgService.getOrganization(orgId);
    const orgName = org?.name || "Organization";

    // --- Generate PDF ---
    const pdfReportService = new PdfReportService();
    const pdfBuffer = await pdfReportService.generateReport(orgId, orgName);

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