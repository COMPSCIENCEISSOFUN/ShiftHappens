/**
 * Hardening for anything that puts a user's own words into a model prompt.
 *
 */

/** Longest user message any prompt will carry. */
export const MAX_PROMPT_INPUT = 500;

/*
 * Phrasings that only ever appear in an attempt to restate the model's
 * instructions. Deliberately narrow: a broad filter that catches "act as a
 * barista" would break the product it is protecting, and a false positive here
 * is a user whose ordinary question is mangled into nonsense.
 */
const OVERRIDE_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions|prompts|rules)/gi,
  /disregard\s+(all\s+)?(previous|above|prior)/gi,
  /you\s+are\s+now/gi,
  /act\s+as\s+(a|an)/gi,
  /pretend\s+(to\s+be|you\s+are)/gi,
  /system\s*prompt/gi,
  /\bDAN\b/g,
  /do\s+anything\s+now/gi,
  /jailbreak/gi,
];

/**
 * Trims a user's message to something safe to interpolate into a prompt.
 *
 * Capped first, then stripped of markup, then of override phrasings. The order
 * matters: capping afterwards could cut a replacement in half, and stripping
 * tags after the phrase pass would let `ig<b>nore all previous instructions`
 * through by hiding the phrase from the patterns.
 */
export function sanitisePromptInput(text: string): string {
  let out = text.slice(0, MAX_PROMPT_INPUT);

  // Markup, which is both an injection vector and noise the model does not need.
  out = out.replace(/<[^>]*>/g, "");

  for (const pattern of OVERRIDE_PATTERNS) {
    out = out.replace(pattern, "[removed]");
  }

  return out.trim();
}
