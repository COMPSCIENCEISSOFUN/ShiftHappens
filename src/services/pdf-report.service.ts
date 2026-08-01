/**
 * PDF Report Service (Control Layer)
 *
 * Generates a concise weekly workforce briefing PDF from ReportingService data.
 */
import { jsPDF } from "jspdf";
import { ReportingService } from "./reporting.service";
import {
  DEFAULT_TIMEZONE,
  dayOfWeekInTimeZone,
  startOfDayInTimeZone,
} from "@/lib/timezone";
import type {
  DepartmentWorkloadItem,
  KeyMetrics,
  StaffUtilizationItem,
} from "./reporting.service";

interface ReportData {
  metrics: KeyMetrics;
  staffUtilization: StaffUtilizationItem[];
  departments: DepartmentWorkloadItem[];
}

const COLOR = {
  textPrimary: [26, 26, 26] as const,
  textSecondary: [107, 114, 128] as const,
  textMuted: [156, 163, 175] as const,
  bgGray: [243, 244, 246] as const,
  borderGray: [210, 214, 220] as const,
};

export class PdfReportService {
  private reportingService = new ReportingService();

  async generateReport(
    organizationId: string,
    orgName: string
  ): Promise<ArrayBuffer> {
    const data = await this.gatherData(organizationId);
    return this.renderPdf(orgName, data);
  }

  private async gatherData(organizationId: string): Promise<ReportData> {
    const [metrics, staffUtilization, departments] = await Promise.all([
      this.reportingService.getKeyMetrics(organizationId),
      this.reportingService.getStaffUtilization(organizationId),
      this.reportingService.getDepartmentWorkload(organizationId),
    ]);

    return { metrics, staffUtilization, departments };
  }

  private renderPdf(orgName: string, data: ReportData): ArrayBuffer {
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const margin = 15;
    const contentWidth = 180;
    let y = margin;

    y = this.renderHeader(doc, orgName, margin, contentWidth, y);
    y = this.renderAtAGlance(doc, data, margin, contentWidth, y);
    y = this.renderPipeline(doc, data.metrics, margin, contentWidth, y);
    y = this.renderDepartments(doc, data.departments, margin, contentWidth, y);
    y = this.renderStaff(doc, data.staffUtilization, margin, contentWidth, y);
    this.renderFooter(doc);

    return doc.output("arraybuffer");
  }

  private renderHeader(
    doc: jsPDF,
    orgName: string,
    margin: number,
    contentWidth: number,
    y: number
  ): number {
    const now = new Date();
    const weekStart = this.getWeekStart(now);
    const weekEnd = new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(...COLOR.textPrimary);
    doc.text("Weekly workforce briefing", margin, y + 5);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...COLOR.textSecondary);
    doc.text(orgName, margin, y + 11);

    doc.setFontSize(8);
    doc.setTextColor(...COLOR.textMuted);
    doc.text(
      `${this.formatDateShort(weekStart)} - ${this.formatDateShort(weekEnd)}`,
      margin + contentWidth,
      y + 5,
      { align: "right" }
    );

    y += 16;
    doc.setDrawColor(...COLOR.textPrimary);
    doc.setLineWidth(0.6);
    doc.line(margin, y, margin + contentWidth, y);
    return y + 7;
  }

  private renderAtAGlance(
    doc: jsPDF,
    data: ReportData,
    margin: number,
    contentWidth: number,
    y: number
  ): number {
    const { assignmentPipeline, completionRate, hoursLogged } = data.metrics;
    const active =
      assignmentPipeline.assigned +
      assignmentPipeline.in_progress +
      assignmentPipeline.clocked_out;
    const staffCount = data.staffUtilization.length;
    const imbalanced = data.departments.filter((d) => d.isImbalanced).length;

    doc.setFillColor(...COLOR.bgGray);
    doc.roundedRect(margin, y, contentWidth, 24, 2, 2, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...COLOR.textPrimary);
    doc.text("This week at a glance", margin + 5, y + 6);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...COLOR.textSecondary);
    const summary =
      `${completionRate.current} assignments completed this week. ` +
      `${active} assignments are currently active or awaiting completion. ` +
      `${hoursLogged.hours}h logged across ${staffCount} staff ` +
      `(${hoursLogged.utilization}% utilization). ` +
      `${imbalanced} department${imbalanced !== 1 ? "s" : ""} need workload review.`;
    doc.text(doc.splitTextToSize(summary, contentWidth - 10), margin + 5, y + 12);
    return y + 31;
  }

  private renderPipeline(
    doc: jsPDF,
    metrics: KeyMetrics,
    margin: number,
    contentWidth: number,
    y: number
  ): number {
    const pipeline = metrics.assignmentPipeline;
    const cards = [
      ["ASSIGNED", pipeline.assigned],
      ["IN PROGRESS", pipeline.in_progress],
      ["CLOCKED OUT", pipeline.clocked_out],
      ["COMPLETED", pipeline.completed],
    ] as const;
    const colWidth = contentWidth / cards.length;

    for (let i = 0; i < cards.length; i++) {
      const [label, value] = cards[i];
      const x = margin + i * colWidth;
      doc.setFillColor(...COLOR.bgGray);
      doc.roundedRect(x + 1, y, colWidth - 2, 18, 2, 2, "F");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.5);
      doc.setTextColor(...COLOR.textMuted);
      doc.text(label, x + 4, y + 5);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(15);
      doc.setTextColor(...COLOR.textPrimary);
      doc.text(String(value), x + 4, y + 13);
    }

    return y + 25;
  }

  private renderDepartments(
    doc: jsPDF,
    departments: DepartmentWorkloadItem[],
    margin: number,
    contentWidth: number,
    y: number
  ): number {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...COLOR.textPrimary);
    doc.text("Department workload", margin, y);
    y += 6;

    for (const dept of departments.slice(0, 8)) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.setTextColor(...COLOR.textPrimary);
      doc.text(dept.name, margin, y);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...COLOR.textSecondary);
      const status = dept.isImbalanced ? "needs review" : "balanced";
      doc.text(
        `${dept.taskCount} tasks, ${dept.staffCount} staff - ${status}`,
        margin + contentWidth,
        y,
        { align: "right" }
      );
      y += 5;
    }

    this.renderSeparator(doc, margin, contentWidth, y);
    return y + 8;
  }

  private renderStaff(
    doc: jsPDF,
    staff: StaffUtilizationItem[],
    margin: number,
    contentWidth: number,
    y: number
  ): number {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...COLOR.textPrimary);
    doc.text("Staff utilization", margin, y);
    y += 6;

    for (const member of staff.slice(0, 10)) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(...COLOR.textPrimary);
      doc.text(member.name, margin, y);
      doc.setTextColor(...COLOR.textSecondary);
      doc.text(
        `${member.hoursWorked}h / ${member.capacity}h (${member.percentage}%)`,
        margin + contentWidth,
        y,
        { align: "right" }
      );
      y += 5;
    }

    return y;
  }

  private renderSeparator(
    doc: jsPDF,
    margin: number,
    contentWidth: number,
    y: number
  ): void {
    doc.setDrawColor(...COLOR.borderGray);
    doc.setLineWidth(0.2);
    doc.line(margin, y, margin + contentWidth, y);
  }

  private renderFooter(doc: jsPDF): void {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...COLOR.textMuted);
    doc.text("Generated by ShiftHappens", 105, 290, { align: "center" });
  }

  private getWeekStart(date: Date): Date {
    const day = dayOfWeekInTimeZone(date);
    const diff = day === 0 ? -6 : 1 - day;
    return startOfDayInTimeZone(new Date(date.getTime() + diff * 24 * 60 * 60 * 1000));
  }

  private formatDateShort(date: Date): string {
    return date.toLocaleDateString("en-US", {
      timeZone: DEFAULT_TIMEZONE,
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
}
