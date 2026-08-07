/**
 * NextAuth Configuration (Boundary Layer)
 * 
 * Configures authentication using the Credentials provider with
 * JWT session strategy. Users authenticate with email/password.
 * 
 * Security:
 * - Passwords validated via AuthService (bcrypt comparison)
 * - Email verification required before login is allowed
 * - CSRF protection handled automatically by NextAuth
 * - User ID stored in JWT token for session identification
 */
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { AuthService } from "@/services/auth.service";
import { prisma } from "@/lib/prisma";

const authService = new AuthService();

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: {},
        password: {},
      },
      authorize: async (credentials) => {
        const email = credentials.email as string;
        const password = credentials.password as string;

        if (!email || !password) return null;

        // Validate credentials against database (Control layer)
        const user = await authService.validateCredentials(email, password);
        if (!user) return null;

        // Block login for unverified email addresses
        if (!user.emailVerified) return null;

        // Platform admins bypass org suspension check
        if (!user.isPlatformAdmin) {
          // Check if user belongs to at least one active org
          const memberships = await prisma.membership.findMany({
            where: { userId: user.id, status: "active" },
            include: { organization: { select: { status: true } } },
          });
          if (memberships.length > 0) {
            const hasActiveOrg = memberships.some(
              (m) => m.organization.status === "active"
            );
            if (!hasActiveOrg) return null;
          }
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          isPlatformAdmin: user.isPlatformAdmin,
          sessionVersion: user.sessionVersion,
        };
      },
    }),
  ],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    /** Store user ID in JWT token on sign-in */
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.isPlatformAdmin = (user as Record<string, unknown>).isPlatformAdmin ?? false;
        token.sessionVersion = (user as Record<string, unknown>).sessionVersion ?? 0;
      }
      return token;
    },
    /** Expose user ID in session object for server-side access */
    async session({ session, token }) {
      if (token.id) {
        session.user.id = token.id as string;
      }
      (session.user as unknown as Record<string, unknown>).isPlatformAdmin = token.isPlatformAdmin ?? false;
      (session.user as unknown as Record<string, unknown>).sessionVersion = token.sessionVersion ?? 0;
      return session;
    },
  },
  session: {
    strategy: "jwt",
    maxAge: 8 * 60 * 60,
  },
});
