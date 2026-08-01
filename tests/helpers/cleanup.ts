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
  await prisma.certificationDefinition.deleteMany();
  await prisma.availabilityOverride.deleteMany();
  await prisma.availability.deleteMany();
  await prisma.taskAssignment.deleteMany();
  await prisma.task.deleteMany();
  await prisma.workRule.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.companySettings.deleteMany();
  await prisma.invitationToken.deleteMany();
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
