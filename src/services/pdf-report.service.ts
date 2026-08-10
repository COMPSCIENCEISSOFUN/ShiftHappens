/**
 * PDF Report Service (Control Layer)
 *
 * Generates a one-page weekly workforce briefing PDF.
 * Aggregates data from ReportingService (no new repository queries)
 * and renders a narrative-format report using jsPDF.
 *
 * Narrative sections are generated algorithmically from structured data —
 * deterministic, fast, no AI provider dependency.
 *
 * Pro+ feature — gated at API route level via SubscriptionService.
 *
 * BCE compliant: Service (Control) → ReportingService (Control) → Repository (Entity).
 */
import { REASON_PHRASE } from "@/lib/decline-reasons";
import { jsPDF } from "jspdf";
import { ReportingService } from "./reporting.service";
import { AuditLogService, ACTIONS } from "./audit-log.service";
import { DEFAULT_TIMEZONE, SERVER_LOCALE, dayOfWeekInTimeZone, startOfDayInTimeZone } from "@/lib/timezone";
import type {
  KeyMetrics,
  StaffUtilizationItem,
  DepartmentWorkloadItem,
  RejectionTrendItem,
} from "./reporting.service";

// ============================================================
// Internal data structure for the report
// ============================================================

interface ReportData {
  metrics: KeyMetrics;
  staffUtilization: StaffUtilizationItem[];
  departments: DepartmentWorkloadItem[];
  rejections: RejectionTrendItem[];
}

// ============================================================
// Color constants (Tailwind-adjacent, print-safe)
// ============================================================

const COLOR = {
  textPrimary: [26, 26, 26] as const,
  textSecondary: [107, 114, 128] as const,
  textMuted: [156, 163, 175] as const,
  success: [5, 150, 105] as const,
  warning: [217, 119, 6] as const,
  danger: [220, 38, 38] as const,
  bgGray: [243, 244, 246] as const,
  borderGray: [210, 214, 220] as const,
  headerLine: [26, 26, 26] as const,
};

/**
 * Rejection reasons as prose, for dropping into a sentence.
 *
 * Derived from the shared map rather than restated, so a reason added to
 * `DECLINE_REASONS` cannot silently be missing here. `unspecified` is local: it
 * is not a value anyone can choose, it is what the report calls a row with no
 * reason recorded at all.
 */
const REJECTION_LABELS: Record<string, string> = {
  ...REASON_PHRASE,
  unspecified: "unspecified reasons",
};

// ============================================================
// Service
// ============================================================

export class PdfReportService {
  private reportingService = new ReportingService();
  private auditService = new AuditLogService();

  /**
   * Generates the weekly workforce briefing PDF.
   * Returns a Buffer suitable for HTTP response.
   */
  /**
   * `departmentIds` is the caller's scope: null for a company admin, the
   * manager's own departments otherwise.
   *
   * It was missing, and the omission mattered more here than anywhere else in
   * the application. Every other reporting surface a manager can reach is
   * department-scoped; this one produced a PDF — a durable, shareable,
   * downloadable artefact — containing every staff member's name and worked
   * hours across the whole organisation, plus per-person rejection history.
   * A manager scoped to the kitchen could download the entire company's
   * timesheet summary, and take it with them.
   */
  /**
   * `exportedById` is who asked. Optional in the type and load-bearing in
   * practice: the route always passes it, and leaving it off simply records the
   * export with no author rather than refusing to produce one.
   */
  async generateReport(
    organizationId: string,
    orgName: string,
    departmentIds?: string[] | null,
    exportedById?: string
  ): Promise<ArrayBuffer> {
    const data = await this.gatherData(organizationId, departmentIds);
    const pdf = this.renderPdf(orgName, data);

    /*
     * Audited HERE, in the Control layer, and not at the route.
     *
     * It was written at the route first, and `audit-coverage.test.ts` caught
     * it: that suite scans `src/services` for every declared action, which
     * encodes a convention nobody had written down — audit entries are raised
     * by Control, never by Boundary. The route knew who and what; only the
     * service knows the document was actually produced, which is the thing
     * being recorded.
     *
     * This is the one audited action that records an EXTRACTION rather than a
     * change. Every other entry describes a row somebody can still open; this
     * describes a file that has left the product, and once downloaded no
     * permission change, deactivation or downgrade can reach it again.
     *
     * `scope` is the field worth having. The same button hands a department
     * manager their own team's figures and an admin the whole company's, and
     * afterwards the two files are indistinguishable unless the log says which
     * was taken.
     *
     * Stored in a variable and returned after the side effect, per the house
     * rule: a logging failure must never cost the caller the report.
     */
    void this.auditService.log({
      organizationId,
      userId: exportedById,
      action: ACTIONS.REPORT_EXPORTED,
      entityType: "report",
      details: {
        format: "pdf",
        scope: departmentIds == null ? "org-wide" : departmentIds,
        bytes: pdf.byteLength,
      },
    });

    return pdf;
  }

  // ===== Data Gathering =====

  /** Calls existing ReportingService methods in parallel */
  private async gatherData(
    organizationId: string,
    departmentIds?: string[] | null
  ): Promise<ReportData> {
    // `?? undefined` because these methods take `string[] | undefined`, and a
    // company admin's scope is expressed as null. Both mean unrestricted.
    const scope = departmentIds ?? undefined;

    const [metrics, staffUtilization, departments, rejections] =
      await Promise.all([
        this.reportingService.getKeyMetrics(organizationId, scope),
        this.reportingService.getStaffUtilization(organizationId, scope),
        this.reportingService.getDepartmentWorkload(organizationId, scope),
        this.reportingService.getRejectionTrends(organizationId, scope),
      ]);

    return { metrics, staffUtilization, departments, rejections };
  }

  // ===== PDF Rendering =====

  /** Assembles the full PDF document and returns it as a ArrayBuffer */
  private renderPdf(orgName: string, data: ReportData): ArrayBuffer {
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const margin = 15;
    const pageWidth = 210;
    const contentWidth = pageWidth - margin * 2;
    let y = margin;

    // --- Header ---
    y = this.renderHeader(doc, orgName, margin, contentWidth, y);

    // --- At a glance ---
    y = this.renderAtAGlance(doc, data, margin, contentWidth, y);

    // --- Key metrics ---
    y = this.renderKeyMetrics(doc, data.metrics, margin, contentWidth, y);

    // --- What went well ---
    y = this.renderWhatWentWell(doc, data, margin, contentWidth, y);

    // --- What needs attention ---
    y = this.renderWhatNeedsAttention(doc, data, margin, contentWidth, y);

    // --- Separator ---
    y = this.renderSeparator(doc, margin, contentWidth, y);

    // --- Department breakdown ---
    y = this.renderDepartmentBreakdown(doc, data.departments, margin, contentWidth, y);

    // --- Staff summary table ---
    y = this.renderStaffTable(doc, data.staffUtilization, margin, contentWidth, y);

    // --- Separator ---
    y = this.renderSeparator(doc, margin, contentWidth, y);

    // --- Rejection breakdown ---
    y = this.renderRejectionBreakdown(doc, data.rejections, margin, contentWidth, y);

    // --- Recommendations ---
    y = this.renderRecommendations(doc, data, margin, contentWidth, y);

    // --- Footer ---
    this.renderFooter(doc, pageWidth);

    return doc.output("arraybuffer");
  }

  // ===== Section Renderers =====

  private renderHeader(
    doc: jsPDF,
    orgName: string,
    margin: number,
    contentWidth: number,
    y: number
  ): number {
    const now = new Date();
    const weekStart = this.getWeekStart(now);
    // Six whole days after the Monday boundary — exact for a fixed-offset zone.
    const weekEnd = new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000);

    // Title
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(...COLOR.textPrimary);
    doc.text("Weekly workforce briefing", margin, y + 5);

    // Org name
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(...COLOR.textSecondary);
    doc.text(orgName, margin, y + 11);

    // Date range (right-aligned)
    doc.setFontSize(8);
    doc.setTextColor(...COLOR.textMuted);
    const dateRange = `${this.formatDateShort(weekStart)} – ${this.formatDateShort(weekEnd)}`;
    doc.text(dateRange, margin + contentWidth, y + 5, { align: "right" });
    const generated = `Generated ${this.formatDateShort(now)}, ${this.formatTime(now)}`;
    doc.text(generated, margin + contentWidth, y + 9, { align: "right" });

    // Header line
    y += 15;
    doc.setDrawColor(...COLOR.headerLine);
    doc.setLineWidth(0.6);
    doc.line(margin, y, margin + contentWidth, y);

    return y + 6;
  }

  private renderAtAGlance(
    doc: jsPDF,
    data: ReportData,
    margin: number,
    contentWidth: number,
    y: number
  ): number {
    const { metrics, departments, rejections } = data;
    const completed = metrics.completionRate.current;
    const total = metrics.assignmentPipeline.total || completed;
    const rate = total > 0 ? Math.round((completed / total) * 100) : 0;
    const staffCount = data.staffUtilization.length;
    const totalRejections = rejections.reduce((sum, r) => sum + r.rejectionCount, 0);

    // Background box
    doc.setFillColor(...COLOR.bgGray);
    const boxHeight = 20;
    doc.roundedRect(margin, y, contentWidth, boxHeight, 2, 2, "F");

    // Heading
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...COLOR.textPrimary);
    doc.text("This week at a glance", margin + 5, y + 5.5);

    // Summary text
    const trendWord = metrics.completionRate.trend === "up" ? "A strong" : metrics.completionRate.trend === "down" ? "A challenging" : "A steady";
    let summary = `${trendWord} week with ${completed} of ${total} assignments completed (${rate}%). `;
    summary += `${metrics.hoursLogged.hours}h logged across ${staffCount} staff (${metrics.hoursLogged.utilization}% utilization).`;
    if (totalRejections > 0) {
      summary += ` ${totalRejections} rejection${totalRejections !== 1 ? "s" : ""} recorded.`;
    }

    const imbalanced = departments.filter((d) => d.isImbalanced);
    if (imbalanced.length > 0) {
      summary += ` ${imbalanced[0].name} staffing requires attention.`;
    }

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...COLOR.textSecondary);
    const lines = doc.splitTextToSize(summary, contentWidth - 10);
    doc.text(lines, margin + 5, y + 10);

    return y + boxHeight + 5;
  }

  private renderKeyMetrics(
    doc: jsPDF,
    metrics: KeyMetrics,
    margin: number,
    contentWidth: number,
    y: number
  ): number {
    const colWidth = contentWidth / 3;
    const completed = metrics.completionRate.current;
    const total = metrics.assignmentPipeline.total || completed;
    const rate = total > 0 ? Math.round((completed / total) * 100) : 0;
    const totalRejections =
      metrics.assignmentPipeline.rejected;

    const cards = [
      {
        label: "COMPLETION RATE",
        value: `${rate}%`,
        sub:
          metrics.completionRate.trend === "up"
            ? `↑ from ${metrics.completionRate.previous} last week`
            : metrics.completionRate.trend === "down"
              ? `↓ from ${metrics.completionRate.previous} last week`
              : "Same as last week",
        subColor:
          metrics.completionRate.trend === "up" ? COLOR.success
            : metrics.completionRate.trend === "down" ? COLOR.danger
              : COLOR.textMuted,
      },
      {
        label: "HOURS LOGGED",
        value: `${metrics.hoursLogged.hours}h`,
        sub: `of ${metrics.hoursLogged.capacity}h capacity (${metrics.hoursLogged.utilization}%)`,
        subColor: COLOR.textSecondary,
      },
      {
        label: "REJECTIONS",
        value: `${totalRejections}`,
        sub: totalRejections > 0 ? "this week" : "none this week",
        subColor: totalRejections > 3 ? COLOR.warning : COLOR.textMuted,
      },
    ];

    for (let i = 0; i < cards.length; i++) {
      const x = margin + i * colWidth;
      const card = cards[i];

      // Card background
      doc.setFillColor(...COLOR.bgGray);
      doc.roundedRect(x + (i > 0 ? 2 : 0), y, colWidth - 4, 18, 2, 2, "F");

      // Label
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6);
      doc.setTextColor(...COLOR.textMuted);
      doc.text(card.label, x + 4 + (i > 0 ? 2 : 0), y + 5);

      // Value
      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.setTextColor(...COLOR.textPrimary);
      doc.text(card.value, x + 4 + (i > 0 ? 2 : 0), y + 12);

      // Sub text
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.5);
      doc.setTextColor(card.subColor[0], card.subColor[1], card.subColor[2]);
      doc.text(card.sub, x + 4 + (i > 0 ? 2 : 0), y + 16);
    }

    return y + 23;
  }

  private renderWhatWentWell(
    doc: jsPDF,
    data: ReportData,
    margin: number,
    contentWidth: number,
    y: number
  ): number {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...COLOR.textPrimary);
    doc.text("What went well", margin, y + 4);
    y += 8;

    const points: string[] = [];
    const { metrics, departments, rejections, staffUtilization } = data;

    if (metrics.completionRate.trend === "up") {
      points.push(
        `Task completion rate improved from ${metrics.completionRate.previous} to ${metrics.completionRate.current} completed assignments week-over-week.`
      );
    } else if (metrics.completionRate.current > 0) {
      points.push(
        `${metrics.completionRate.current} assignments completed this week.`
      );
    }

    if (metrics.hoursLogged.utilization > 60) {
      points.push(
        `Staff utilization averaged ${metrics.hoursLogged.utilization}%, indicating good schedule-to-availability alignment.`
      );
    }

    const deptsNoRejections = departments.filter(
      (d) => d.taskCount > 0 && !data.rejections.some((r) => r.rejectionCount > 0)
    );
    if (deptsNoRejections.length > 0 && rejections.length > 0) {
      // Only mention clean depts if there are rejections elsewhere
      const cleanDept = deptsNoRejections[0];
      points.push(`${cleanDept.name} maintained clean operations with no rejections.`);
    }

    const topPerformer = staffUtilization.length > 0 ? staffUtilization[0] : null;
    if (topPerformer && topPerformer.percentage > 70) {
      points.push(
        `${topPerformer.name} led utilization at ${topPerformer.percentage}%.`
      );
    }

    if (points.length === 0) {
      points.push("Steady operations this week with no significant issues to highlight.");
    }

    const text = points.join(" ");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...COLOR.textSecondary);
    const lines = doc.splitTextToSize(text, contentWidth);
    doc.text(lines, margin, y);
    y += lines.length * 3.5 + 3;

    return y;
  }

  private renderWhatNeedsAttention(
    doc: jsPDF,
    data: ReportData,
    margin: number,
    contentWidth: number,
    y: number
  ): number {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...COLOR.textPrimary);
    doc.text("What needs attention", margin, y + 4);
    y += 8;

    const points: string[] = [];
    const { departments, rejections, staffUtilization } = data;

    // Imbalanced departments
    const imbalanced = departments.filter((d) => d.isImbalanced);
    for (const dept of imbalanced.slice(0, 2)) {
      if (dept.staffCount === 0) {
        points.push(
          `${dept.name} has ${dept.taskCount} active task${dept.taskCount !== 1 ? "s" : ""} but no staff assigned.`
        );
      } else {
        points.push(
          `${dept.name} has a ${dept.taskCount}:${dept.staffCount} task-to-staff ratio — consider rebalancing.`
        );
      }
    }

    // Staff with rejections
    for (const staff of rejections.slice(0, 2)) {
      const topReason = staff.reasons[0];
      const reasonLabel = REJECTION_LABELS[topReason.reason] || topReason.reason;
      points.push(
        `${staff.staffName} rejected ${staff.rejectionCount} assignment${staff.rejectionCount !== 1 ? "s" : ""} — primarily ${reasonLabel}.`
      );
    }

    // Low utilization staff
    const lowUtil = staffUtilization.filter((s) => s.percentage < 30 && s.percentage > 0);
    if (lowUtil.length > 0) {
      const names = lowUtil
        .slice(0, 2)
        .map((s) => s.name)
        .join(" and ");
      points.push(`${names} ha${lowUtil.length > 1 ? "ve" : "s"} utilization below 30% — may be underassigned.`);
    }

    if (points.length === 0) {
      points.push("No significant concerns this week. Operations running smoothly.");
    }

    const text = points.join(" ");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...COLOR.textSecondary);
    const lines = doc.splitTextToSize(text, contentWidth);
    doc.text(lines, margin, y);
    y += lines.length * 3.5 + 2;

    return y;
  }

  private renderSeparator(
    doc: jsPDF,
    margin: number,
    contentWidth: number,
    y: number
  ): number {
    doc.setDrawColor(...COLOR.borderGray);
    doc.setLineWidth(0.2);
    doc.line(margin, y, margin + contentWidth, y);
    return y + 5;
  }

  private renderDepartmentBreakdown(
    doc: jsPDF,
    departments: DepartmentWorkloadItem[],
    margin: number,
    contentWidth: number,
    y: number
  ): number {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...COLOR.textPrimary);
    doc.text("Department breakdown", margin, y + 4);
    y += 9;

    for (const dept of departments) {
      // Color dot
      const [r, g, b] = this.hexToRgb(dept.color);
      doc.setFillColor(r, g, b);
      doc.circle(margin + 2, y + 1, 1.5, "F");

      // Department name
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(...COLOR.textPrimary);
      doc.text(dept.name, margin + 6, y + 2.5);

      // Task/staff count
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(...COLOR.textMuted);
      const countText = `${dept.taskCount} task${dept.taskCount !== 1 ? "s" : ""} · ${dept.staffCount} staff`;
      const nameWidth = doc.getTextWidth(dept.name);
      doc.text(countText, margin + 6 + nameWidth + 3, y + 2.5);

      // Description line
      y += 5;
      let desc: string;
      if (dept.isImbalanced && dept.staffCount === 0) {
        desc = "No staff assigned — coverage gap. Reassignment or hiring recommended.";
      } else if (dept.isImbalanced) {
        desc = `High task-to-staff ratio (${dept.taskCount}:${dept.staffCount}). Consider redistributing workload.`;
      } else if (dept.taskCount === 0) {
        desc = "No active tasks this period.";
      } else {
        desc = `Operating within normal parameters.`;
      }

      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(...COLOR.textSecondary);
      const lines = doc.splitTextToSize(desc, contentWidth - 7);
      doc.text(lines, margin + 6, y);
      y += lines.length * 3.2 + 3;
    }

    return y + 1;
  }

  private renderStaffTable(
    doc: jsPDF,
    staff: StaffUtilizationItem[],
    margin: number,
    contentWidth: number,
    y: number
  ): number {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...COLOR.textPrimary);
    doc.text("Staff summary", margin, y + 4);
    y += 9;

    // Column positions
    const cols = {
      name: margin,
      hours: margin + contentWidth * 0.55,
      utilBar: margin + contentWidth * 0.68,
      utilPct: margin + contentWidth - 1,
    };

    // Header row
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...COLOR.textMuted);
    doc.text("Name", cols.name, y);
    doc.text("Hours", cols.hours, y, { align: "right" });
    doc.text("Utilization", cols.utilPct, y, { align: "right" });

    y += 2;
    doc.setDrawColor(...COLOR.borderGray);
    doc.setLineWidth(0.2);
    doc.line(margin, y, margin + contentWidth, y);
    y += 3.5;

    // Data rows (limit to 8 to fit on page)
    const displayStaff = staff.slice(0, 8);
    for (const s of displayStaff) {
      // Name
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      const isLowUtil = s.percentage < 30;
      const nameColor = isLowUtil ? COLOR.warning : COLOR.textPrimary;
      doc.setTextColor(nameColor[0], nameColor[1], nameColor[2]);
      doc.text(s.name, cols.name, y);

      // Hours
      doc.setTextColor(...COLOR.textPrimary);
      doc.text(`${s.hoursWorked}h`, cols.hours, y, { align: "right" });

      // Utilization bar
      const barWidth = contentWidth * 0.24;
      const barX = cols.utilBar;
      const barY = y - 2;
      const barHeight = 3;
      const fillWidth = Math.min((s.percentage / 100) * barWidth, barWidth);

      // Background track
      doc.setFillColor(...COLOR.bgGray);
      doc.roundedRect(barX, barY, barWidth, barHeight, 1, 1, "F");

      // Fill
      if (s.percentage > 60) {
        doc.setFillColor(59, 130, 246); // blue
      } else if (s.percentage > 30) {
        doc.setFillColor(156, 163, 175); // gray
      } else {
        doc.setFillColor(...COLOR.warning); // amber
      }
      if (fillWidth > 0) {
        doc.roundedRect(barX, barY, fillWidth, barHeight, 1, 1, "F");
      }

      // Percentage
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(...COLOR.textSecondary);
      doc.text(`${s.percentage}%`, cols.utilPct, y, { align: "right" });

      y += 5.5;
    }

    if (staff.length > 8) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7);
      doc.setTextColor(...COLOR.textMuted);
      doc.text(`+${staff.length - 8} more staff members`, margin, y);
      y += 4;
    }

    return y + 1;
  }

  private renderRejectionBreakdown(
    doc: jsPDF,
    rejections: RejectionTrendItem[],
    margin: number,
    contentWidth: number,
    y: number
  ): number {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...COLOR.textPrimary);
    doc.text("Rejection breakdown", margin, y + 4);
    y += 8;

    if (rejections.length === 0) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(...COLOR.textSecondary);
      doc.text("No rejections this week.", margin, y);
      return y + 5;
    }

    const totalRejections = rejections.reduce(
      (sum, r) => sum + r.rejectionCount,
      0
    );

    // Build narrative
    const parts: string[] = [];
    parts.push(
      `${totalRejections} rejection${totalRejections !== 1 ? "s" : ""} this week.`
    );

    // Group by reason across all staff
    const reasonTotals = new Map<string, { count: number; staffNames: string[] }>();
    for (const staff of rejections) {
      for (const r of staff.reasons) {
        const existing = reasonTotals.get(r.reason) || { count: 0, staffNames: [] };
        existing.count += r.count;
        existing.staffNames.push(`${staff.staffName} (×${r.count})`);
        reasonTotals.set(r.reason, existing);
      }
    }

    const sortedReasons = Array.from(reasonTotals.entries())
      .sort((a, b) => b[1].count - a[1].count);

    for (const [reason, data] of sortedReasons.slice(0, 3)) {
      const label = REJECTION_LABELS[reason] || reason;
      const names = data.staffNames.slice(0, 3).join(", ");
      parts.push(`${label.charAt(0).toUpperCase() + label.slice(1)}: ${data.count} — ${names}.`);
    }

    // Pattern note for top rejector
    const topRejector = rejections[0];
    if (topRejector.rejectionCount >= 2) {
      const topReason = topRejector.reasons[0];
      const reasonLabel = REJECTION_LABELS[topReason.reason] || topReason.reason;
      if (topReason.reason === "schedule_conflict") {
        parts.push(
          `${topRejector.staffName}'s rejections are concentrated on ${reasonLabel} — their availability may need updating.`
        );
      }
    }

    const text = parts.join(" ");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...COLOR.textSecondary);
    const lines = doc.splitTextToSize(text, contentWidth);
    doc.text(lines, margin, y);
    y += lines.length * 3.5 + 2;

    return y;
  }

  private renderRecommendations(
    doc: jsPDF,
    data: ReportData,
    margin: number,
    contentWidth: number,
    y: number
  ): number {
    const recommendations = this.generateRecommendations(data);
    if (recommendations.length === 0) return y;

    // Background box
    const boxPadding = 5;
    const innerWidth = contentWidth - boxPadding * 2;

    // Pre-calculate box height
    doc.setFontSize(8.5);
    let textHeight = 6; // heading space
    for (const rec of recommendations) {
      const lines = doc.splitTextToSize(`${rec}`, innerWidth - 6);
      textHeight += lines.length * 3.5 + 2;
    }

    doc.setFillColor(...COLOR.bgGray);
    doc.roundedRect(margin, y, contentWidth, textHeight + boxPadding + 2, 2, 2, "F");

    // Heading
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...COLOR.textPrimary);
    doc.text("Recommendations", margin + boxPadding, y + 5.5);
    y += 10;

    // Items
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    for (let i = 0; i < recommendations.length; i++) {
      doc.setTextColor(...COLOR.textPrimary);
      doc.text(`${i + 1}.`, margin + boxPadding, y);

      doc.setTextColor(...COLOR.textSecondary);
      const lines = doc.splitTextToSize(recommendations[i], innerWidth - 6);
      doc.text(lines, margin + boxPadding + 5, y);
      y += lines.length * 3.5 + 2;
    }

    return y + 2;
  }

  private renderFooter(doc: jsPDF, pageWidth: number): void {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...COLOR.textMuted);
    doc.text(
      "Generated by Smart Task Allocation",
      pageWidth / 2,
      290,
      { align: "center" }
    );
  }

  // ===== Narrative Generation =====

  /** Generates data-driven recommendations from the report data */
  private generateRecommendations(data: ReportData): string[] {
    const recs: string[] = [];
    const { departments, rejections, staffUtilization } = data;

    // Rejection-based recommendations
    for (const staff of rejections.slice(0, 1)) {
      if (staff.rejectionCount >= 2) {
        const topReason = staff.reasons[0];
        if (topReason.reason === "schedule_conflict") {
          const pct = Math.round(
            (topReason.count / staff.rejectionCount) * 100
          );
          recs.push(
            `Update ${staff.staffName}'s availability schedule — ${pct}% of their rejections stem from schedule conflicts, indicating a mismatch between declared hours and assigned shifts.`
          );
        } else {
          const reasonLabel = REJECTION_LABELS[topReason.reason] || topReason.reason;
          recs.push(
            `Review assignment patterns for ${staff.staffName} — ${staff.rejectionCount} rejections this week, primarily ${reasonLabel}.`
          );
        }
      }
    }

    // Department imbalance recommendations
    const imbalanced = departments.filter((d) => d.isImbalanced);
    for (const dept of imbalanced.slice(0, 1)) {
      if (dept.staffCount === 0) {
        recs.push(
          `Recruit or reassign staff to ${dept.name} — ${dept.taskCount} active task${dept.taskCount !== 1 ? "s" : ""} with no staff coverage creates a single point of failure.`
        );
      } else {
        recs.push(
          `Rebalance ${dept.name} workload — the ${dept.taskCount}:${dept.staffCount} task-to-staff ratio is high and risks burnout.`
        );
      }
    }

    // Utilization gap recommendations
    if (staffUtilization.length >= 2) {
      const highest = staffUtilization[0];
      const lowest = staffUtilization[staffUtilization.length - 1];
      if (
        highest.percentage > 70 &&
        lowest.percentage < 40 &&
        highest.percentage - lowest.percentage > 30
      ) {
        recs.push(
          `Redistribute shifts more evenly — ${highest.name} is at ${highest.percentage}% utilization while ${lowest.name} sits at ${lowest.percentage}%. Rebalancing improves fairness and reduces burnout risk.`
        );
      }
    }

    return recs.slice(0, 3);
  }

  // ===== Utility Helpers =====

  /**
   * Gets Monday 00:00 of the week containing the given date, in the
   * organisation's timezone. Resolved there rather than on the server clock:
   * on Vercel the weekday flips eight hours early, so a report generated on a
   * Monday morning in Singapore would cover the *previous* week.
   */
  private getWeekStart(date: Date): Date {
    const day = dayOfWeekInTimeZone(date);
    const diff = day === 0 ? -6 : 1 - day;
    const DAY_MS = 24 * 60 * 60 * 1000;
    return startOfDayInTimeZone(new Date(date.getTime() + diff * DAY_MS));
  }

  /**
   * Formats a date as "Jul 14, 2026" in the organisation's timezone.
   * A printed report must show the reader's dates, not the server's.
   */
  private formatDateShort(date: Date): string {
    return date.toLocaleDateString(SERVER_LOCALE, {
      timeZone: DEFAULT_TIMEZONE,
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  /** Formats time as "10:30 AM" in the organisation's timezone. */
  private formatTime(date: Date): string {
    return date.toLocaleTimeString(SERVER_LOCALE, {
      timeZone: DEFAULT_TIMEZONE,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  /** Converts hex color string to RGB tuple */
  private hexToRgb(hex: string): [number, number, number] {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (result) {
      return [
        parseInt(result[1], 16),
        parseInt(result[2], 16),
        parseInt(result[3], 16),
      ];
    }
    return [148, 163, 184]; // Tailwind slate-400 fallback
  }
}