/**
 * User Repository (Entity Layer)
 * 
 * Data access layer for User model operations.
 * All database queries are encapsulated here — the Control layer
 * (services) calls these methods rather than using Prisma directly.
 * 
 * Security: Prisma parameterized queries prevent SQL injection.
 */
import { prisma } from "@/lib/prisma";

export class UserRepository {
  /** Creates a new user with hashed password */
  async create(data: {
    name: string;
    email: string;
    hashedPassword: string;
  }) {
    return prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        hashedPassword: data.hashedPassword,
      },
    });
  }

  /** Finds a user by email — used for login and duplicate checking */
  async findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  }

  /** Finds a user by ID — used for session-based lookups */
  async findById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  }

  /**
   * Whether a user carries the platform-admin flag.
   *
   * Selects the single column rather than the whole row: this is an
   * authorisation check that runs on every platform-admin request, and it has
   * no business loading a password hash to answer a yes/no question.
   *
   * A missing user reads as false — a caller whose account has been deleted is
   * refused for the same reason as an ordinary user, and cannot tell the two
   * apart.
   */
  async isPlatformAdmin(id: string): Promise<boolean> {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { isPlatformAdmin: true },
    });
    return user?.isPlatformAdmin === true;
  }

  /**
   * Finds a user by ID returning only non-sensitive fields.
   * Safe to pass to client components — no password hash.
   */
  async findPublicById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        emailVerified: true,
      },
    });
  }

  /** Updates user profile fields (name and/or password) */
  async updateProfile(
    id: string,
    data: { name?: string; hashedPassword?: string }
  ) {
    return prisma.user.update({
      where: { id },
      data,
    });
  }

  /**
   * Finds a user by ID with their org memberships included.
   * Used by the Profile page to show which orgs the user belongs to.
   */
  async findByIdWithMemberships(id: string) {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        image: true,
        createdAt: true,
        memberships: {
          select: {
            id: true,
            role: true,
            status: true,
            employmentType: true,
            createdAt: true,
            organization: {
              select: {
                id: true,
                name: true,
                slug: true,
              },
            },
            customRole: {
              select: {
                id: true,
                name: true,
                displayLabel: true,
              },
            },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
    });
  }

  /** Sets the emailVerified timestamp — called after token verification */
  async verifyEmail(id: string) {
    return prisma.user.update({
      where: { id },
      data: { emailVerified: new Date() },
    });
  }
}