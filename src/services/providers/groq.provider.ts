/**
 * Groq AI Provider (Control Layer)
 * 
 * Implements the AIProvider interface using Groq's API
 * with the Llama model for staff ranking and allocation.
 * 
 * Groq offers fast inference with a generous free tier
 * (30 req/min, 14,400 req/day).
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

export class GroqProvider implements AIProvider {
  readonly name = "groq" as const;

  private apiKey: string;
  private model: string;

  constructor() {
    this.apiKey = process.env.GROQ_API_KEY || "";
    this.model = "llama-3.1-8b-instant";
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
      throw new Error("Groq provider unavailable: API key not configured");
    }

    if (candidates.length === 0) {
      return [];
    }

    const prompt = this.buildPrompt(task, candidates);

    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        // Without this the failover below is unreachable on a hang — see
        // AI_TIMEOUT_MS. A socket that never answers is neither an error nor a
        // non-ok response, so nothing advances to the next provider.
        signal: aiTimeoutSignal(),
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content: `You are a smart task allocation assistant for shift-based businesses. 
You rank staff members for task assignments based on their fitness.
You MUST respond with ONLY a valid JSON array, no other text.
Each element must have: membershipId (string), rank (number starting at 1), score (number 0-100), explanation (string).
Rank by: lowest hours worked today first, matching department experience, valid certifications, availability fit.
Higher score = better fit.`,
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0,
          max_tokens: 1000,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("[Groq API Error]", error);
        throw new Error("AI provider request failed");
      }

      const data = await response.json();
      const content = data.choices[0]?.message?.content || "[]";

      return this.parseResponse(content, candidates);
    } catch (error) {
      console.error("[Groq Provider Error]", error);
      // Rethrow so the failover chain can try the next provider, then
      // FallbackRanker. Swallowing this made the chain Groq-or-nothing.
      throw error instanceof Error
        ? error
        : new Error("Groq provider request failed");
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
    const schedule = task.scheduledStart && task.scheduledEnd
      ? `${task.scheduledStart} to ${task.scheduledEnd}`
      : "No specific schedule";

    let prompt = `Rank these staff members for the following task assignment.\n\n`;
    prompt += `TASK:\n`;
    prompt += `- Title: ${task.title}\n`;
    prompt += `- Department: ${task.department || "None"}\n`;
    prompt += `- Priority: ${task.priority}\n`;
    prompt += `- Schedule: ${schedule}\n`;
    prompt += `- Required headcount: ${task.requiredHeadcount}\n`;
    // Guidance, not arithmetic — see `priorities` on the AIProvider interface.
    if (task.priorities) {
      prompt += `\nRANKING PRIORITIES (most important first): ${task.priorities}\n`;
    }
    prompt += `\n`;
    prompt += `ELIGIBLE STAFF:\n`;

    for (const c of candidates) {
      prompt += `- ID: ${c.membershipId}\n`;
      prompt += `  Name: ${c.name}\n`;
      prompt += `  Hours worked today: ${c.hoursWorkedToday}h of ${c.maxHours}h limit\n`;
      prompt += `  Certifications: ${c.certifications.length > 0 ? c.certifications.join(", ") : "None"}\n`;
      prompt += `  Available hours: ${c.availableHours}\n`;
      prompt += `  Times worked in this department: ${c.departmentHistory}\n\n`;
    }

    prompt += `Return a JSON array ranking ALL staff from most to least suitable.`;

    return prompt;
  }

  private parseResponse(content: string, candidates: StaffCandidate[]): RankedStaff[] {
    try {
      // Clean potential markdown code blocks
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
      console.error("[Groq Parse Error]", error, "Content:", content);
    }

    // An unusable response is a provider failure like any other — let the
    // failover chain decide what to do about it.
    throw new Error("Groq returned an unparseable ranking");
  }

}