/**
 * Organization Repository (Entity Layer)
 * 
 * Data access layer for Organization model operations.
 * Handles org creation (with initial membership), lookups, 
 * and slug uniqueness checks.
 * 
 * Multi-tenancy: Organization queries support tenant isolation
 * through org-scoped lookups.
 */
import { prisma } from "@/lib/prisma";

export class OrganizationRepository {
  /**
   * Creates a new organization and assigns the creator as company_admin.
   * Uses a nested Prisma write to atomically create both the org and membership.
   */
  /**
   * An organisation's status, or null when it does not exist.
   *
   * Narrow on purpose: the suspension guard runs on almost every request, so it
   * selects one column and nothing else. Previously `src/lib/org-guard.ts` ran
   * this query against Prisma directly, putting an Entity-layer call in a
   * helper the Boundary imports.
   */
  async getStatus(id: string): Promise<string | null> {
    const org = await prisma.organization.findUnique({
      where: { id },
      select: { status: true },
    });
    return org?.status ?? null;
  }

  async create(
    data: {
      name: string;
      slug: string;
      industry?: string;
      description?: string;
    },
    creatorUserId: string
  ) {
    return prisma.organization.create({
      data: {
        name: data.name,
        slug: data.slug,
        industry: data.industry,
        description: data.description,
        memberships: {
          create: {
            userId: creatorUserId,
            role: "company_admin",
            status: "active",
          },
        },
      },
      include: { memberships: true },
    });
  }

  /**
   * Updates an organization's details by ID.
   * Accepts partial updates — only provided fields are changed.
   */
  async update(
    id: string,
    data: {
      name?: string;
      slug?: string;
      industry?: string | null;
      description?: string | null;
      logo?: string | null;
      address?: string | null;
      templateId?: string | null;
    }
  ) {
    return prisma.organization.update({
      where: { id },
      data,
    });
  }

  /** Finds an organization by its URL-friendly slug */
  async findBySlug(slug: string) {
    return prisma.organization.findUnique({ where: { slug } });
  }

  /** Finds an organization by its ID */
  async findById(id: string) {
    return prisma.organization.findUnique({ where: { id } });
  }

  /**
   * Finds all organizations a user belongs to (with active membership).
   * Includes the user's role in each organization.
   * Supports multi-org staff who can belong to multiple companies.
   */
  async findByUserId(userId: string) {
    return prisma.organization.findMany({
      where: {
        memberships: {
          some: { userId, status: "active" },
        },
      },
      include: {
        memberships: {
          // Active only, matching the outer filter. Without it a member who
          // was deactivated from an org they had also been re-added to could
          // have the dead row read first, and `memberships[0].role` — which
          // the dashboard uses to choose which dashboard to render — would be
          // the role they no longer hold.
          where: { userId, status: "active" },
          select: { role: true },
        },
      },
      /*
       * Oldest first, and a TOTAL order.
       *
       * Callers that need a default organisation take `[0]`. With no ordering
       * at all Postgres may return a different row on successive requests, so
       * for anyone in more than one organisation the sidebar's org name, role
       * badge and menu could change between two loads of the same page — and,
       * before the org layout existed, so could the permission set every page
       * gated on.
       *
       * `createdAt` ALONE is only a PARTIAL order. Prisma maps `DateTime` to
       * `timestamp(3)`, so two organisations created in the same millisecond
       * tie, and Postgres guarantees nothing about ties — a sort that looks
       * deterministic and is not. The `id` tiebreak makes it total; cuid's
       * base36 timestamp and per-process counter mean it also agrees with
       * creation order.
       *
       * Honest note on evidence: this fix is by CONSTRUCTION, not by observed
       * failure. `IndustryTemplateRepository.OLDEST_FIRST` is the same fault and
       * there it is demonstrable — a tie plus a heap rewrite flips the list, and
       * `industry-template.repository.test.ts` pins exactly that. The equivalent
       * could not be provoked for this query shape: Postgres's sort happened to
       * be stable for it at every row count tried. So there is no test here that
       * fails without the tiebreak, and one was deliberately NOT written rather
       * than leave a green assertion that measures nothing.
       */
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  /**
   * IDs of every active organisation, for the platform-wide background jobs.
   *
   * The only query in the codebase that deliberately spans tenants: the cron
   * entry point has no organisation of its own and has to discover them.
   * Suspended orgs are left out so a tenant that has stopped paying does not
   * keep receiving generated shifts and notifications.
   */
  async findActiveIds(): Promise<string[]> {
    const orgs = await prisma.organization.findMany({
      where: { status: "active" },
      select: { id: true },
    });
    return orgs.map((o) => o.id);
  }

  /** Checks if a slug is already taken — used during slug generation */
  async slugExists(slug: string): Promise<boolean> {
    const count = await prisma.organization.count({ where: { slug } });
    return count > 0;
  }
}