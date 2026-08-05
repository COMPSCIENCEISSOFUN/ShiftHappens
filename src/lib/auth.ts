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
import { AccessService } from "@/services/access.service";

const authService = new AuthService();
const accessService = new AccessService();

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

        // Platform admins bypass the org suspension check.
        //
        // Through the Control layer, not a raw query. This module is imported
        // by `auth-guard.ts`, which every route calls, so the `prisma` access
        // that used to be here put Boundary→Entity on the hot path for the
        // whole application.
        if (!user.isPlatformAdmin) {
          const mayEnter = await accessService.maySignIn(user.id);
          if (!mayEnter) return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          isPlatformAdmin: user.isPlatformAdmin,
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
      }
      return token;
    },
    /** Expose user ID in session object for server-side access */
    async session({ session, token }) {
      if (token.id) {
        session.user.id = token.id as string;
      }
      (session.user as unknown as Record<string, unknown>).isPlatformAdmin = token.isPlatformAdmin ?? false;
      return session;
    },
  },
  session: {
    strategy: "jwt",
  },
});