/**
 * `cn` merges class names AND resolves Tailwind conflicts. The second part is
 * the one that surprises people: it silently drops earlier classes it thinks
 * lose, which is how a component prop stops overriding a default.
 */
import { describe, it, expect } from "vitest";
import { cn } from "@/lib/utils";

describe("cn", () => {
  it("joins class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("drops falsy values", () => {
    expect(cn("a", false, null, undefined, "", "b")).toBe("a b");
  });

  it("accepts conditional objects and arrays", () => {
    expect(cn(["a", "b"], { c: true, d: false })).toBe("a b c");
  });

  it("lets a later Tailwind class win over an earlier conflicting one", () => {
    // The whole reason components take a className prop.
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("keeps classes from different Tailwind groups", () => {
    // Size and colour are different groups, so both survive — this is what
    // StatTile relies on when it merges a valueColour onto its base classes.
    expect(cn("text-xl font-bold", "text-green-600")).toBe(
      "text-xl font-bold text-green-600"
    );
  });

  it("keeps a responsive variant alongside its base class", () => {
    expect(cn("text-xl", "sm:text-2xl")).toBe("text-xl sm:text-2xl");
  });

  it("keeps a dark variant alongside its light counterpart", () => {
    expect(cn("text-green-600", "dark:text-green-400")).toBe(
      "text-green-600 dark:text-green-400"
    );
  });

  it("returns an empty string for no input", () => {
    expect(cn()).toBe("");
    expect(cn(undefined)).toBe("");
  });
});
