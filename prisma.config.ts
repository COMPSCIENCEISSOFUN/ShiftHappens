import "dotenv/config";
import { defineConfig } from "prisma/config";

// Supabase's direct host is IPv6-only on projects without the IPv4 add-on.
// Prisma migrations need a session connection, so derive the IPv4-compatible
// Session pooler URL from the runtime Transaction pooler URL for CLI commands.
const runtimeUrl = process.env.DATABASE_URL;
if (runtimeUrl?.includes(".pooler.supabase.com")) {
  const sessionPoolerUrl = new URL(runtimeUrl);
  sessionPoolerUrl.port = "5432";
  sessionPoolerUrl.searchParams.delete("pgbouncer");
  process.env.DIRECT_URL = sessionPoolerUrl.toString();
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "npx tsx prisma/seed.ts",
  },
});
