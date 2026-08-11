/**
 * Shared test database cleanup utility.
 * Deletes all records in the correct order to respect foreign key constraints.
 * Update this single file when new tables are added.
 */
import { prisma } from "@/lib/prisma";

export async function cleanDatabase() {
  await prisma.notification.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.eligibilityOverride.deleteMany();
  await prisma.certification.deleteMany();
  // Before Organization, which it cascades from — the order in this file is a
  // dependency order, not an alphabetical one.
  await prisma.certificationType.deleteMany();
  await prisma.availabilityOverride.deleteMany();
  await prisma.availability.deleteMany();
  await prisma.taskAssignment.deleteMany();
  await prisma.projectMember.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.workRule.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.companySettings.deleteMany();
  await prisma.invitationToken.deleteMany();
  // Listed rather than left to cascade from Membership. It WOULD cascade, and
  // so would departmentMembership below it — this file states its tables
  // explicitly on purpose, so a relation later changed to SetNull does not
  // silently start leaking rows between tests.
  await prisma.calendarFeed.deleteMany();
  await prisma.departmentMembership.deleteMany();
  await prisma.department.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.verificationToken.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.session.deleteMany();
  await prisma.account.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.industryTemplate.deleteMany();
  await prisma.user.deleteMany();
}