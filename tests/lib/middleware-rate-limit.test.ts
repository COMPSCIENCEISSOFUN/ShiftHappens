import { describe, expect, it } from "vitest";
import { getTier } from "@/middleware";

describe("middleware rate-limit tiers", () => {
  it("keeps normal NextAuth support endpoints relaxed", () => {
    expect(getTier("/api/auth/providers")).toBe("relaxed");
    expect(getTier("/api/auth/csrf")).toBe("relaxed");
    expect(getTier("/api/auth/session")).toBe("relaxed");
    expect(getTier("/api/auth/signout")).toBe("relaxed");
  });

  it("moderately limits credential submission for UAT-friendly login/logout", () => {
    expect(getTier("/api/auth/callback/credentials")).toBe("moderate");
  });

  it("keeps registration and password recovery strict", () => {
    expect(getTier("/api/register")).toBe("strict");
    expect(getTier("/api/forgot-password")).toBe("strict");
    expect(getTier("/api/reset-password")).toBe("strict");
  });
});
