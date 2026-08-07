/**
 * Gemini AI Provider (Control Layer)
 * 
 * Implements the AIProvider interface using Google's Gemini API.
 * Backup provider if Groq is unavailable.
 * Free tier: 15 req/min, 1M tokens/day.
 */
import { aiTimeoutSignal } from "@/lib/ai-limits";
import type { AIProvider, StaffCandidate, RankedStaff } from "../ai-provider";

/**
 * One entry of whatever the model returned, before it is trusted.
 *
 * `unknown`-valued fields rather than `any`: this is parsed JSON from a language
 * model, so every field is a claim, not a fact. Typing them as `unknown` forces
 * the coercions below to stay — `item.rank || index + 1` and the score clamp are
 * the only things standing between a hallucinated payload and the ranking the
 * scheduler acts on. With `any` those guards could be deleted and nothing would
 * complain.
 */
interface UntrustedRanking {
  membershipId?: unknown;
  rank?: unknown;
  score?: unknown;
  explanation?: unknown;
}

export class GeminiProvider implements AIProvider {
  readonly name = "gemini" as const;

  private apiKey: string;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || "";
  }

  async rankStaff(
    task: {
      title: string;
      department: string | null;
      priority: string;
      priorities?: string;
      scheduledStart: string | null;
      scheduledEnd: string | null;
      requiredHeadcount: number;
    },
    candidates: StaffCandidate[]
  ): Promise<RankedStaff[]> {
    if (!this.apiKey) {
      // Throw rather than ranking locally. AllocationService.rankWithFailover
      // advances to the next provider only on a throw, so returning a private
      // ranking here made this provider terminal: the sibling provider was
      // never reached and FallbackRanker — the documented 4-factor ranker —
      // was unreachable. The Strategy pattern only works if failure propagates.
      throw new Error("Gemini provider unavailable: API key not configured");
    }

    if (candidates.length === 0) {
      return [];
    }

    const prompt = this.buildPrompt(task, candidates);

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`,
        {
          // Without this the failover below is unreachable on a hang — see
          // AI_TIMEOUT_MS. A socket that never answers is neither an error nor a
          // non-ok response, so nothing advances to the next provider.
          signal: aiTimeoutSignal(),
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

      return this.parseResponse(content, candidates);
    } catch (error) {
      console.error("[Gemini Provider Error]", error);
      // Rethrow so the failover chain can fall through to FallbackRanker.
      throw error instanceof Error
        ? error
        : new Error("Gemini provider request failed");
    }
  }

  private buildPrompt(
    task: {
      title: string;
      department: string | null;
      priority: string;
      priorities?: string;
      scheduledStart: string | null;
      scheduledEnd: string | null;
      requiredHeadcount: number;
    },
    candidates: StaffCandidate[]
  ): string {
    let prompt = `You are a smart task allocation assistant. Rank staff for a task assignment.\n`;
    prompt += `Respond with ONLY a valid JSON array. No other text.\n`;
    prompt += `Each element: { "membershipId": string, "rank": number, "score": 0-100, "explanation": string }\n\n`;
    prompt += `TASK: "${task.title}", Department: ${task.department || "None"}, Priority: ${task.priority}\n`;
    prompt += `Schedule: ${task.scheduledStart && task.scheduledEnd ? `${task.scheduledStart} to ${task.scheduledEnd}` : "Flexible"}\n`;
    prompt += `Needs: ${task.requiredHeadcount} staff\n`;
    // Guidance, not arithmetic — see `priorities` on the AIProvider interface.
    if (task.priorities) {
      prompt += `RANKING PRIORITIES (most important first): ${task.priorities}\n`;
    }
    prompt += `\n`;
    prompt += `STAFF:\n`;

    for (const c of candidates) {
      prompt += `- ${c.name} (${c.membershipId}): ${c.hoursWorkedToday}h/${c.maxHours}h worked, `;
      prompt += `certs: ${c.certifications.join(", ") || "none"}, `;
      prompt += `available: ${c.availableHours}, dept experience: ${c.departmentHistory}x\n`;
    }

    prompt += `\nRank by: fewest hours worked, department experience, certifications, availability fit. Higher score = better.`;

    return prompt;
  }

  private parseResponse(content: string, candidates: StaffCandidate[]): RankedStaff[] {
    try {
      const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const parsed = JSON.parse(cleaned);

      if (Array.isArray(parsed)) {
        return parsed.map((item: UntrustedRanking, index: number) => ({
          membershipId:
            typeof item.membershipId === "string" && item.membershipId
              ? item.membershipId
              : candidates[index]?.membershipId || "",
          rank: typeof item.rank === "number" ? item.rank : index + 1,
          score:
            typeof item.score === "number"
              ? Math.min(100, Math.max(0, item.score))
              : 0,
          explanation:
            typeof item.explanation === "string" && item.explanation
              ? item.explanation
              : "No explanation provided",
        }));
      }
    } catch (error) {
      console.error("[Gemini Parse Error]", error);
    }

    // An unusable response is a provider failure like any other.
    throw new Error("Gemini returned an unparseable ranking");
  }

}