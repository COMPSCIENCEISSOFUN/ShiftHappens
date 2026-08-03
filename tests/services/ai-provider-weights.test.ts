import { afterEach, describe, expect, it, vi } from "vitest";
import { GroqProvider } from "@/services/providers/groq.provider";
import { GeminiProvider } from "@/services/providers/gemini.provider";
import type { StaffCandidate } from "@/services/ai-provider";
import type { AllocationWeights } from "@/lib/allocation-weights";

const task = {
  title: "Prepare service",
  department: "Kitchen",
  priority: "high",
  scheduledStart: "2026-08-03T08:00:00.000Z",
  scheduledEnd: "2026-08-03T10:00:00.000Z",
  requiredHeadcount: 1,
};
const candidates: StaffCandidate[] = [
  {
    membershipId: "member-1",
    name: "Alex",
    hoursWorkedToday: 1,
    maxHours: 8,
    certifications: ["Food Safety"],
    availableHours: "Mon 08:00-16:00",
    departmentHistory: 4,
  },
];
const weights: AllocationWeights = {
  workloadBalance: 10,
  availabilityFit: 20,
  certificationBreadth: 30,
  departmentExperience: 40,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("AI provider ranking priorities", () => {
  it("includes normalized priorities in the Groq prompt", async () => {
    vi.stubEnv("GROQ_API_KEY", "test-key");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  { membershipId: "member-1", rank: 1, score: 90, explanation: "fit" },
                ]),
              },
            },
          ],
        }),
        { status: 200 }
      )
    );

    await new GroqProvider().rankStaff(task, candidates, weights);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages[1].content).toContain("Workload balance: 10%");
    expect(body.messages[1].content).toContain("Department experience: 40%");
  });

  it("includes normalized priorities in the Gemini prompt", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify([
                      { membershipId: "member-1", rank: 1, score: 90, explanation: "fit" },
                    ]),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      )
    );

    await new GeminiProvider().rankStaff(task, candidates, weights);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.contents[0].parts[0].text).toContain("workload balance 10%");
    expect(body.contents[0].parts[0].text).toContain("department experience 40%");
  });
});
