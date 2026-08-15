/**
 * Certification Type Service (Control Layer)
 *
 * The organisation's list of recognised certificates.
 */
import { CertificationTypeRepository } from "@/repositories/certification-type.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";

export class CertificationTypeService {
  private repo = new CertificationTypeRepository();
  private auditService = new AuditLogService();

  /** The list, alphabetical. Both pickers and the admin panel read this. */
  async list(organizationId: string) {
    return this.repo.findByOrganizationId(organizationId);
  }

  /**
   * Adds a name to the list.
   *
   * Case-insensitive uniqueness, which is stricter than the database's unique
   * index and has to be: eligibility lower-cases before comparing, so "Food
   * Safety" and "food safety" are one certificate, and admitting both would put
   * a choice in front of a manager where there is only one thing to choose.
   */
  async create(organizationId: string, rawName: string, userId?: string) {
    const name = rawName.trim();
    if (!name) {
      throw new Error("A certificate name is required");
    }

    const clash = await this.repo.nameExistsInOrg(name, organizationId);
    if (clash) {
      throw new Error(`"${name}" is already on the list`);
    }

    const type = await this.repo.create(organizationId, name);

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.CERTIFICATION_TYPE_ADDED,
      entityType: "certification",
      entityId: type.id,
      details: { name },
    });

    return type;
  }

  /**
   * Removes a name from the list — refusing while any shift still requires it.
   *
   * ## Why a refusal rather than a warning
   *
   * Removing a type does not delete anything. The requirement is a stored
   * string on the task and eligibility keeps enforcing it, so the shift goes on
   * working. What breaks is quieter: the task form offers only names on this
   * list, so opening that shift to change its start time and saving would drop
   * the requirement it can no longer represent. A shift that silently stops
   * checking for a food-safety certificate is exactly the failure this whole
   * change was made to prevent, arriving by a different door.
   *
   * A count, not names, unlike the equivalent guard on roles. Work rules are a
   * short list an admin can go and retarget; tasks run to hundreds and naming
   * them would produce a sentence nobody can act on. The number tells them
   * whether this is one stale shift or half the roster.
   */
  async remove(typeId: string, organizationId: string, userId?: string) {
    const type = await this.repo.findById(typeId);
    if (!type || type.organizationId !== organizationId) {
      throw new Error("Certificate not found");
    }

    const inUse = await this.repo.countTasksRequiring(organizationId, type.name);
    if (inUse > 0) {
      throw new Error(
        `Cannot remove: ${inUse} task${inUse === 1 ? "" : "s"} still ` +
          `require${inUse === 1 ? "s" : ""} "${type.name}". ` +
          `Remove it from those tasks first.`
      );
    }

    const removed = await this.repo.delete(typeId);

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.CERTIFICATION_TYPE_REMOVED,
      entityType: "certification",
      entityId: typeId,
      details: { name: type.name },
    });

    return removed;
  }
}
