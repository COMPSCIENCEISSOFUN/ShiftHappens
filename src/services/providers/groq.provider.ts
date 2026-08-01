/**
 * Groq AI Provider (Control Layer)
 * 
 * Implements the AIProvider interface using Groq's API
 * with the Llama model for staff ranking and allocation.
 * 
 * Groq offers fast inference with a generous free tier
 * (30 req/min, 14,400 req/day).
 */
import type { AIProvider, StaffCandidate, RankedStaff } from "../ai-provider";

export class GroqProvider implements AIProvider {
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
      scheduledStart: string | null;
      scheduledEnd: string | null;
      requiredHeadcount: number;
    },
    candidates: StaffCandidate[]
  ): Promise<RankedStaff[]> {
    if (!this.apiKey) {
      return this.fallbackRanking(candidates);
    }

    if (candidates.length === 0) {
      return [];
    }

    const prompt = this.buildPrompt(task, candidates);

    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
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
      // Fallback: return candidates ranked by hours worked (lowest first)
      return this.fallbackRanking(candidates);
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
    prompt += `- Required headcount: ${task.requiredHeadcount}\n\n`;
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
      console.error("[Groq Parse Error]", error, "Content:", content);
    }

    // If parsing fails, use fallback
    return this.fallbackRanking(candidates);
  }

  /** Simple fallback ranking by hours worked (lowest first) */
  private fallbackRanking(candidates: StaffCandidate[]): RankedStaff[] {
    return [...candidates]
      .sort((a, b) => a.hoursWorkedToday - b.hoursWorkedToday)
      .map((c, i) => ({
        membershipId: c.membershipId,
        rank: i + 1,
        score: Math.max(0, 100 - c.hoursWorkedToday * 10),
        explanation: `${c.name}: ${c.hoursWorkedToday}h worked today, ${c.certifications.length} cert(s)`,
      }));
  }
}
