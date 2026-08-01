/**
 * Tests for PDF Report Service (Control Layer)
 *
 * Smoke tests verifying the PDF generation pipeline produces
 * valid output across different data shapes. Data query correctness
 * is already covered by ReportingService tests — these tests verify
 * the rendering layer doesn't crash and produces valid PDFs.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PdfReportService } from "@/services/pdf-report.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const pdfService = new PdfReportService();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;
let adminUserId: string;

beforeEach(async () => {
  await cleanDatabase();

  const user = await userRepo.create({
    name: "Admin",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  adminUserId = user.id;

  const org = await orgRepo.create(
    { name: "Ocean Grill", slug: "ocean-grill" },
    user.id
  );
  orgId = org.id;

  // Pre-create settings to avoid race condition when
  // parallel getOrCreate calls hit the unique constraint
  await prisma.companySettings.create({
    data: { organizationId: orgId },
  });
});

describe("PdfReportService", () => {
  describe("generateReport", () => {
    it("generates a valid PDF with minimal data", async () => {
      const result = await pdfService.generateReport(orgId, "Ocean Grill");

      expect(result).toBeInstanceOf(ArrayBuffer);
      expect(result.byteLength).toBeGreaterThan(0);
    });

    it("output starts with PDF header bytes", async () => {
      const result = await pdfService.generateReport(orgId, "Ocean Grill");

      const bytes = new Uint8Array(result);
      const header = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
      expect(header).toBe("%PDF");
    });

    it("handles org with no staff or tasks gracefully", async () => {
      const result = await pdfService.generateReport(orgId, "Empty Org");

      expect(result).toBeInstanceOf(ArrayBuffer);
      expect(result.byteLength).toBeGreaterThan(0);
    });

    it("generates PDF with departments and staff", async () => {
      await prisma.department.create({
        data: { name: "Kitchen", color: "#FF0000", organizationId: orgId },
      });

      const staffUser = await userRepo.create({
        name: "Alex Rivera",
        email: "alex@example.com",
        hashedPassword: "hash",
      });
      await prisma.membership.create({
        data: {
          userId: staffUser.id,
          organizationId: orgId,
          role: "staff",
          status: "active",
        },
      });

      const result = await pdfService.generateReport(orgId, "Ocean Grill");

      expect(result).toBeInstanceOf(ArrayBuffer);
      expect(result.byteLength).toBeGreaterThan(0);
    });

    it("generates PDF with multiple departments", async () => {
      await prisma.department.createMany({
        data: [
          { name: "Kitchen", color: "#FF0000", organizationId: orgId },
          { name: "Bar", color: "#00FF00", organizationId: orgId },
          { name: "Front of House", color: "#0000FF", organizationId: orgId },
        ],
      });

      const result = await pdfService.generateReport(orgId, "Ocean Grill");

      expect(result).toBeInstanceOf(ArrayBuffer);
      expect(result.byteLength).toBeGreaterThan(0);
    });

    it("handles cancelled assignment data in the report", async () => {
      const dept = await prisma.department.create({
        data: { name: "Bar", color: "#00FF00", organizationId: orgId },
      });

      const staffUser = await userRepo.create({
        name: "Jamie Park",
        email: "jamie@example.com",
        hashedPassword: "hash",
      });
      const membership = await prisma.membership.create({
        data: {
          userId: staffUser.id,
          organizationId: orgId,
          role: "staff",
          status: "active",
        },
      });

      const task = await prisma.task.create({
        data: {
          title: "Bar Prep",
          organizationId: orgId,
          departmentId: dept.id,
          status: "open",
          priority: "medium",
          requiredHeadcount: 1,
          createdById: adminUserId,
        },
      });

      await prisma.taskAssignment.create({
        data: {
          taskId: task.id,
          membershipId: membership.id,
          status: "cancelled",
          assignedById: adminUserId,
        },
      });

      const result = await pdfService.generateReport(orgId, "Ocean Grill");

      expect(result).toBeInstanceOf(ArrayBuffer);
      expect(result.byteLength).toBeGreaterThan(0);
    });

    it("handles imbalanced departments without crashing", async () => {
      const dept = await prisma.department.create({
        data: { name: "Kitchen", color: "#FF0000", organizationId: orgId },
      });

      await prisma.task.create({
        data: {
          title: "Lunch Service",
          organizationId: orgId,
          departmentId: dept.id,
          status: "open",
          priority: "high",
          requiredHeadcount: 3,
          createdById: adminUserId,
        },
      });

      const result = await pdfService.generateReport(orgId, "Ocean Grill");

      expect(result).toBeInstanceOf(ArrayBuffer);
      expect(result.byteLength).toBeGreaterThan(0);
    });

    it("generates consistently sized output for same data", async () => {
      const result1 = await pdfService.generateReport(orgId, "Ocean Grill");
      const result2 = await pdfService.generateReport(orgId, "Ocean Grill");

      expect(result1.byteLength).toBe(result2.byteLength);
    });
  });
});
