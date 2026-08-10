/**
 * Hardening for anything that puts a user's own words into a model prompt.
 *
 * ## Why this is shared
 *
 * `AITaskParserService` wrote this first and wrote it well — length cap, tag
 * stripping, a list of override phrases — with a docblock calling it one of
 * five layers of defence. It then lived as a private method on that one class,
 * so the assistant would have started by copying it, and the two copies would
 * have drifted the first time either learned a new pattern.
 *
 * That is the shape `button-styles.ts` was extracted to prevent, and the shape
 * the success banners were in an hour ago: a rule applied correctly in one
 * file and absent from the others. Stated once, so a new caller cannot quietly
 * omit it.
 *
 * ## What this is NOT
 *
 * It is not the defence. A blocklist of phrasings is the weakest layer here and
 * would be worthless on its own — "ignore all previous instructions" has
 * infinite spellings and this catches a handful of them.
 *
 * The defence is architectural, and it is worth stating plainly because it is
 * the thing that makes the feature safe rather than merely careful: **the model
 * holds no credentials and fetches nothing.** It reads a sentence and returns
 * one identifier from a closed list. Every fact in the answer is fetched
 * afterwards, by services that resolve the caller's organisation and
 * permissions independently and would refuse the same request arriving from
 * anywhere else.
 *
 * So the ceiling on a successful injection is that the model returns the wrong
 * identifier from the list — and the caller is then shown a different, equally
 * permitted answer about their own organisation. There is nothing to escalate
 * to, because the model was never holding anything.
 *
 * This function narrows the input anyway. Defence in depth means the cheap
 * layer still gets written; it does not mean the cheap layer is trusted.
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
