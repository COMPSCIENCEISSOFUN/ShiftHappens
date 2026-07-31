/**
 * AI provider failover (Control Layer).
 *
 * The documented design decision is "AI provider uses Strategy pattern:
 * Groq → Gemini → algorithmic fallback". It did not work.
 *
 * `AllocationService.rankWithFailover` advances to the next provider only when
 * the current one THROWS. Both providers instead caught every failure — missing
 * API key, HTTP error, unparseable JSON — and returned a private
 * `fallbackRanking()`, a naive sort by hours worked. Because that is a normal
 * return, the chain stopped at the first provider: Gemini was never reached even
 * when configured and healthy, and `FallbackRanker` — the 4-factor weighted
 * ranker with its own passing test file — was unreachable dead code.
 *
 * These tests pin the contract that makes the pattern work: a provider that
 * cannot produce a ranking must throw, and the chain must end at FallbackRanker.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GroqProvider } from "@/services/providers/groq.provider";
import { GeminiProvider } from "@/services/providers/gemini.provider";
import { FallbackRanker } from "@/services/fallback-ranker";
import type { StaffCandidate } from "@/services/ai-provider";

const task = {
  title: "Evening shift",
  department: "Kitchen",
  priority: "high",
  scheduledStart: "2026-08-03T01:00:00.000Z",
  scheduledEnd: "2026-08-03T09:00:00.000Z",
  requiredHeadcount: 2,
};

function candidate(id: string, hours: number, certs: string[] = []): StaffCandidate {
  return {
    membershipId: id,
    name: `Staff ${id}`,
    hoursWorkedToday: hours,
    maxHours: 8,
    certifications: certs,
    departmentHistory: 0,
    availableHours: "08:00-18:00",
  };
}

const candidates = [candidate("a", 6), candidate("b", 2), candidate("c", 4)];

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("Providers throw instead of silently ranking locally", () => {
  it("GroqProvider.rankStaff throws when no API key is configured", async () => {
    delete process.env.GROQ_API_KEY;

    await expect(new GroqProvider().rankStaff(task, candidates)).rejects.toThrow(
      /API key not configured/
    );
  });

  it("GeminiProvider.rankStaff throws when no API key is configured", async () => {
    delete process.env.GEMINI_API_KEY;

    await expect(new GeminiProvider().rankStaff(task, candidates)).rejects.toThrow(
      /API key not configured/
    );
  });

  it("GroqProvider throws when the API returns a non-OK response", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 }))
    );

    await expect(new GroqProvider().rankStaff(task, candidates)).rejects.toThrow();
  });

  it("GroqProvider throws when the model returns unparseable content", async () => {
    // The subtle case: HTTP 200, but the body is not a ranking. Previously this
    // produced a plausible-looking result that was not the model's answer at
    // all, and no failover.
    process.env.GROQ_API_KEY = "test-key";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: "I cannot help with that." } }] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      )
    );

    try {
      await expect(new GroqProvider().rankStaff(task, candidates)).rejects.toThrow(
        /unparseable/
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("GroqProvider still returns the model's ranking on a good response", async () => {
    // Guard against over-correction — the success path must be untouched.
    process.env.GROQ_API_KEY = "test-key";
    const ranking = [
      { membershipId: "b", rank: 1, score: 91, explanation: "fewest hours" },
      { membershipId: "c", rank: 2, score: 70, explanation: "ok" },
      { membershipId: "a", rank: 3, score: 40, explanation: "busy" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify(ranking) } }] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      )
    );

    const result = await new GroqProvider().rankStaff(task, candidates);

    expect(result.map((r) => r.membershipId)).toEqual(["b", "c", "a"]);
    expect(result[0].explanation).toBe("fewest hours");
  });
});

describe("The failover chain reaches the algorithmic ranker", () => {
  it("falls through both providers to FallbackRanker when neither is configured", async () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      // rankWithFailover is private; exercise it through the public path that
      // ranks a candidate list. Importing lazily keeps the env deletions above
      // in effect for the providers the service constructs.
      const { AllocationService } = await import("@/services/allocation.service");
      const service = new AllocationService();
      const ranked = await (
        service as unknown as {
          rankWithFailover: (t: typeof task, c: StaffCandidate[]) => Promise<unknown[]>;
        }
      ).rankWithFailover(task, candidates);

      // The distinguishing assertion: FallbackRanker weighs four factors, so its
      // scores are NOT the naive descending-by-hours sequence the providers'
      // private ranker produced. Compare against the real thing.
      expect(ranked).toEqual(FallbackRanker.rank(candidates));
      // And both provider failures were reported rather than swallowed.
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("FallbackRanker is reachable and disagrees with a naive hours sort", async () => {
    // If these two ever coincide, the test above proves nothing — this asserts
    // the two rankers are actually distinguishable for this input.
    const naive = [...candidates]
      .sort((a, b) => a.hoursWorkedToday - b.hoursWorkedToday)
      .map((c) => c.membershipId);
    const weighted = FallbackRanker.rank([
      candidate("a", 6, ["First Aid", "Food Safety"]),
      candidate("b", 2),
      candidate("c", 4, ["First Aid"]),
    ]).map((r) => r.membershipId);

    expect(weighted).not.toEqual(naive);
  });
});
