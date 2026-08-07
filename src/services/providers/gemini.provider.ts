/**
 * Gemini AI Provider (Control Layer)
 * 
 * Implements the AIProvider interface using Google's Gemini API.
 * Backup provider if Groq is unavailable.
 * Free tier: 15 req/min, 1M tokens/day.
 */
import type { AIProvider, StaffCandidate, RankedStaff } from "../ai-provider";
import { FallbackRanker } from "../fallback-ranker";
import type { AllocationWeights } from "@/lib/allocation-weights";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

export class GeminiProvider implements AIProvider {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || "";
  }

  async rankStaff(
    task: {
      title: string;
      department: string | null;
      priority: string;
      scheduledStart: string | null;
      scheduledEnd: string | null;
      requiredHeadcount: number;
    },
    candidates: StaffCandidate[],
    weights: AllocationWeights
  ): Promise<RankedStaff[]> {
    if (!this.apiKey) {
      return FallbackRanker.rank(candidates, weights);
    }

    if (candidates.length === 0) {
      return [];
    }

    const prompt = this.buildPrompt(task, candidates, weights);

    try {
      const response = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 1000,
            },
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        console.error("[Gemini API Error]", error);
        throw new Error("AI provider request failed");
      }

      const data = await response.json();
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

      return this.parseResponse(content, candidates, weights);
    } catch (error) {
      console.error("[Gemini Provider Error]", error);
      return FallbackRanker.rank(candidates, weights);
    }
  }

  private buildPrompt(
    task: {
      title: string;
      department: string | null;
      priority: string;
      scheduledStart: string | null;
      scheduledEnd: string | null;
      requiredHeadcount: number;
    },
    candidates: StaffCandidate[],
    weights: AllocationWeights
  ): string {
    let prompt = `You are a smart task allocation assistant. Rank staff for a task assignment.\n`;
    prompt += `Respond with ONLY a valid JSON array. No other text.\n`;
    prompt += `Each element: { "membershipId": string, "rank": number, "score": 0-100, "explanation": string }\n\n`;
    prompt += `TASK: "${task.title}", Department: ${task.department || "None"}, Priority: ${task.priority}\n`;
    prompt += `Schedule: ${task.scheduledStart && task.scheduledEnd ? `${task.scheduledStart} to ${task.scheduledEnd}` : "Flexible"}\n`;
    prompt += `Needs: ${task.requiredHeadcount} staff\n\n`;
    prompt += `RANKING PRIORITIES (normalized percentages): workload balance ${weights.workloadBalance}%, availability fit ${weights.availabilityFit}%, certification breadth ${weights.certificationBreadth}%, department experience ${weights.departmentExperience}%.\n`;
    prompt += `Never include an ineligible person. Explain rankings using only factors with a weight above zero.\n\n`;
    prompt += `STAFF:\n`;

    for (const c of candidates) {
      prompt += `- ${c.name} (${c.membershipId}): ${c.hoursWorkedToday}h/${c.maxHours}h worked, `;
      prompt += `certs: ${c.certifications.join(", ") || "none"}, `;
      prompt += `available: ${c.availableHours}, dept experience: ${c.departmentHistory}x\n`;
    }

    prompt += `\nRank by: fewest hours worked, department experience, certifications, availability fit. Higher score = better.`;

    return prompt;
  }

  private parseResponse(
    content: string,
    candidates: StaffCandidate[],
    weights: AllocationWeights
  ): RankedStaff[] {
    try {
      const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const parsed = JSON.parse(cleaned);

      if (Array.isArray(parsed)) {
        return parsed.map((item: unknown, index: number) => {
          const value =
            typeof item === "object" && item !== null
              ? (item as Record<string, unknown>)
              : {};
          return {
            membershipId:
              typeof value.membershipId === "string"
                ? value.membershipId
                : candidates[index]?.membershipId || "",
            rank: typeof value.rank === "number" ? value.rank : index + 1,
            score: Math.min(
              100,
              Math.max(0, typeof value.score === "number" ? value.score : 0)
            ),
            explanation:
              typeof value.explanation === "string"
                ? value.explanation
                : "No explanation provided",
          };
        });
      }
    } catch (error) {
      console.error("[Gemini Parse Error]", error);
    }

    return FallbackRanker.rank(candidates, weights);
  }
}
