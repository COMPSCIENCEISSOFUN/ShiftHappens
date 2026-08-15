/**
 * AI Template Generation Endpoint (Boundary Layer)
 * POST /api/organizations/generate-template
 *
 * Receives a business description, uses AI (Groq → Gemini fallback)
 * to generate a template name, departments, work rules, and certifications.
 *
 * Input validation:
 * - 20-500 characters
 * - HTML stripped
 * - Prompt injection patterns blocked
 *
 * Output validation:
 * - JSON parsed and structure verified
 * - Name validated as short industry label
 * - Department count capped at 3-6
 * - Work rule types validated against enum
 * - Numeric values checked for sensible ranges
 *
 * Requires authentication (any logged-in user).
 */
import { NextRequest, NextResponse } from "next/server";
import { aiTimeoutSignal, hasApiKey } from "@/lib/ai-limits";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent";

const VALID_RULE_TYPES = ["break_interval", "max_hours_daily", "max_hours_weekly"];
const DEFAULT_COLORS = ["#EF4444", "#3B82F6", "#10B981", "#8B5CF6", "#F59E0B", "#6B7280"];

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous/i,
  /system\s*prompt/i,
  /you\s+are\s+(now|a)/i,
  /pretend\s+to/i,
  /act\s+as/i,
  /forget\s+(your|all)/i,
  /override/i,
  /jailbreak/i,
];

function sanitizeInput(input: string): string {
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .trim();
}

function isInjectionAttempt(input: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(input));
}

const SYSTEM_PROMPT = `You are a workforce management setup assistant. Based on a business description, suggest an organizational structure for shift-based staff scheduling.

Return ONLY valid JSON with this exact structure (no markdown, no backticks, no explanation):
{
  "name": "Short Industry Name (2-4 words, e.g. Dental Clinic, Logistics / Warehousing)",
  "departments": [
    { "name": "Department Name", "description": "What this department handles", "color": "#HEX" }
  ],
  "workRules": [
    { "name": "Rule Name", "type": "break_interval|max_hours_daily|max_hours_weekly", "hoursThreshold": 6, "breakHours": 1, "maxHours": null, "reason": "Why this rule matters" }
  ],
  "certifications": ["Cert Name 1", "Cert Name 2"]
}

Rules:
- "name" should be a concise industry label (2-4 words), NOT the full description
- Suggest 3-5 departments relevant to the business
- Suggest 2-3 work rules appropriate for the industry
- Suggest 2-5 relevant certifications
- For type "break_interval": set hoursThreshold (1-12) and breakHours (0.5-2), maxHours null
- For type "max_hours_daily": set maxHours (4-16), hoursThreshold and breakHours null
- For type "max_hours_weekly": set maxHours (20-60), hoursThreshold and breakHours null
- Colors must be valid hex colors from this set: #EF4444, #3B82F6, #10B981, #8B5CF6, #F59E0B, #6B7280, #EC4899, #14B8A6
- Department names should be concise (1-3 words)
- Respond ONLY with the JSON object`;

/** What a provider gave back, and whether it refused rather than answered. */
interface ProviderReply {
  text: string | null;
  refused: boolean;
}

async function callGroq(description: string): Promise<ProviderReply> {
  const apiKey = process.env.GROQ_API_KEY;
  // Unconfigured is a refusal too: the user cannot fix it by rewriting.
  if (!hasApiKey(apiKey)) return { text: null, refused: true };

  try {
    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      signal: aiTimeoutSignal(),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Business description: ${description}` },
        ],
        temperature: 0,
        max_tokens: 1000,
      }),
    });

    // A non-ok status is the provider refusing — a rate limit or a revoked key
    // — not the description being unusable. Distinguished so the message can
    // stop telling the user to rewrite prose that was never the problem.
    if (!response.ok) {
      console.error(`[Generate Template] Groq ${response.status}`);
      return { text: null, refused: true };
    }
    const data = await response.json();
    return { text: data.choices?.[0]?.message?.content || null, refused: false };
  } catch (error) {
    console.error("[Generate Template] Groq failed:", error);
    return { text: null, refused: true };
  }
}

async function callGemini(description: string): Promise<ProviderReply> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!hasApiKey(apiKey)) return { text: null, refused: true };

  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: "POST",
      signal: aiTimeoutSignal(),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `${SYSTEM_PROMPT}\n\nBusiness description: ${description}`,
              },
            ],
          },
        ],
        generationConfig: { temperature: 0, maxOutputTokens: 1000 },
      }),
    });

    if (!response.ok) {
      console.error(`[Generate Template] Gemini ${response.status}`);
      return { text: null, refused: true };
    }
    const data = await response.json();
    return {
      text: data.candidates?.[0]?.content?.parts?.[0]?.text || null,
      refused: false,
    };
  } catch (error) {
    console.error("[Generate Template] Gemini failed:", error);
    return { text: null, refused: true };
  }
}

function parseAndValidate(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;

  try {
    const cleaned = raw
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();

    const parsed = JSON.parse(cleaned);

    // Validate name
    parsed.name =
      typeof parsed.name === "string" && parsed.name.trim().length > 0
        ? parsed.name.trim().slice(0, 100)
        : null;

    // Validate departments
    if (!Array.isArray(parsed.departments) || parsed.departments.length === 0)
      return null;

    parsed.departments = parsed.departments.slice(0, 6).map(
      (d: Record<string, unknown>, i: number) => ({
        name: String(d.name || `Department ${i + 1}`).slice(0, 50),
        description: String(d.description || "").slice(0, 200),
        color: DEFAULT_COLORS.includes(String(d.color))
          ? String(d.color)
          : DEFAULT_COLORS[i % DEFAULT_COLORS.length],
      })
    );

    // Validate work rules
    if (!Array.isArray(parsed.workRules)) parsed.workRules = [];
    parsed.workRules = parsed.workRules
      .filter((r: Record<string, unknown>) =>
        VALID_RULE_TYPES.includes(String(r.type))
      )
      .slice(0, 4)
      .map((r: Record<string, unknown>) => {
        const type = String(r.type);
        return {
          name: String(r.name || "Work rule").slice(0, 50),
          type,
          hoursThreshold:
            type === "break_interval"
              ? Math.max(1, Math.min(12, Number(r.hoursThreshold) || 6))
              : null,
          breakHours:
            type === "break_interval"
              ? Math.max(0.5, Math.min(2, Number(r.breakHours) || 1))
              : null,
          maxHours:
            type !== "break_interval"
              ? Math.max(1, Math.min(168, Number(r.maxHours) || 8))
              : null,
          reason: String(r.reason || "Industry standard practice").slice(0, 200),
        };
      });

    // Validate certifications
    if (!Array.isArray(parsed.certifications)) parsed.certifications = [];
    parsed.certifications = parsed.certifications
      .filter((c: unknown) => typeof c === "string" && c.length > 0)
      .slice(0, 5)
      .map((c: string) => c.slice(0, 50));

    return parsed;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const body = await request.json();
    const description = sanitizeInput(String(body.description || ""));

    // Input validation
    if (description.length < 20) {
      return NextResponse.json(
        {
          error:
            "Please provide at least 20 characters describing your business",
        },
        { status: 400 }
      );
    }

    if (description.length > 500) {
      return NextResponse.json(
        { error: "Description must be under 500 characters" },
        { status: 400 }
      );
    }

    if (isInjectionAttempt(description)) {
      return NextResponse.json(
        { error: "Please provide a genuine business description" },
        { status: 400 }
      );
    }

    // Try Groq first, then Gemini
    const groq = await callGroq(description);
    let result = parseAndValidate(groq.text);
    let bothRefused = groq.refused;

    if (!result) {
      const gemini = await callGemini(description);
      result = parseAndValidate(gemini.text);
      bothRefused = bothRefused && gemini.refused;
    }

    if (!result) {
      /*
       * Two different failures, two different messages.
       *
       * This said "try describing your business differently" for both — so a
       * rate limit, a revoked key or an unconfigured environment sent the user
       * away to rewrite prose that was never the problem, and rewriting it
       * would fail identically. The preset templates remain available either
       * way, which is why this stays a 422 the caller can act on rather than a
       * 500.
       */
      return NextResponse.json(
        {
          error: bothRefused
            ? "The assistant is unavailable right now — try again shortly, or use a preset template."
            : "Couldn't turn that into a template. Try describing your business differently, or use a preset template.",
        },
        { status: 422 }
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Generate Template Error]", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}