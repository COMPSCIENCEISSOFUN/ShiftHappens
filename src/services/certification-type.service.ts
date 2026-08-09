/**
 * Certification Type Service (Control Layer)
 *
 * The organisation's list of recognised certificates.
 *
 * ## The bug this exists for
 *
 * A staff member types the name of a certificate they hold. A manager, on a
 * different screen and usually months later, types the name of a certificate a
 * shift requires. `EligibilityService.checkCertifications` compares the two by
 * lower-cased string equality — and nothing ever brought the two vocabularies
 * together. The application's own placeholder text disagreed with itself:
 * "e.g. Food Safety Level 2" on My Certifications, "e.g. Food Safety, RSA" on
 * the task form. Follow both hints and the holder is silently ineligible for a
 * shift they are qualified for, told they are "Missing required
 * certification(s): Food Safety" while holding one.
 *
 * ## Why only one side is closed
 *
 * A TASK may require only a name on this list. A MEMBER may still submit
 * anything.
 *
 * That asymmetry is the design rather than a compromise. A requirement spelled
 * wrong is a shift nobody can fill, which is an operational failure and should
 * be impossible to create. A certificate nobody requires is a true fact about a
 * person — it belongs in their record, verified, with an expiry, and matching
 * nothing is the correct outcome because nothing is asking for it. Closing the
 * member side would leave somebody holding a forklift licence with nowhere to
 * put it.
 *
 * The original bug cannot return through the open side, because requirements
 * now only ever come from this list: a member who typed something free-hand
 * cannot mismatch a requirement, since no requirement names it.
 *
 * ## Names, not ids
 *
 * Neither `Task.requiredCertifications` nor `Certification.name` references
 * this table. Both keep storing names, and the matching rule is untouched —
 * which is what let this be adopted with an add-only migration and no data
 * conversion. The cost is that renaming an entry does not follow into rows
 * already written; that is why there is no rename here at all, only add and
 * remove.
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
