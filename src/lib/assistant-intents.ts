/**
 * The assistant's entire vocabulary — a closed set, and the reason it is safe.
 *
 * ## The shape of the whole feature
 *
 * The model does exactly one thing: it reads a sentence and returns one id
 * from the list below. It is given no credentials, no schema, no query
 * language and no tools. Every fact in the answer is fetched AFTERWARDS by
 * services that resolve the caller's organisation and permissions themselves,
 * and would refuse an out-of-scope request arriving from anywhere else.
 *
 * That is what makes prompt injection uninteresting here rather than merely
 * filtered. The best a successful override can achieve is that the model
 * returns a different id from this list — and the user is then shown a
 * different answer they were already entitled to, about their own
 * organisation. There is nothing to escalate to, because the model never held
 * anything to escalate with.
 *
 * The comparison worth drawing in the write-up: the tempting design is to
 * describe the schema to the model and let it compose a query. That moves
 * tenant isolation from the service layer — where it is enforced, tested and
 * audited — into a sentence of English inside a prompt. In a codebase whose
 * headline finding was a missing server-side org guard, that trade is not
 * available.
 *
 * ## Why the model is not allowed to write the answer either
 *
 * It classifies; it does not phrase. The answers are built from the returned
 * data by ordinary code. A model asked to summarise "Alex worked 31.5 hours"
 * will occasionally say 35, and in a rostering product a plausible wrong
 * number is worse than no assistant — it is indistinguishable from a right
 * one. So the model contributes the INTERPRETATION of the question and nothing
 * else, and no number it emits is ever shown to anybody.
 *
 * ## Scope, and why some of these need no permission
 *
 * `self` intents read the caller's own shifts, hours and requests. They carry
 * no permission because there is no permission to carry: the audit that cut
 * the catalogue from 44 to 28 retired six self-service entries for exactly
 * this reason — a permission that everybody must hold to use the product
 * enforces nothing. Reading your own rota is not a privilege.
 *
 * `organisation` intents each name the permission that already owns that data
 * elsewhere in the product. The assistant does not invent an access rule; it
 * points at the one the page would have used.
 *
 * `assistant:use` sits in front of all of it and is a separate question from
 * any of these: it decides whether you may spend the organisation's provider
 * budget at all.
 *
 * ## And a third question, which is neither permission nor plan
 *
 * A company admin is never put on a shift. The eligibility engine excludes
 * them, `assignStaff` excludes them, and `findSchedulableStaff` excludes them
 * in the query — so "when is my next shift" has no honest answer for an admin,
 * and offering it produced a permanently empty one beside a link to a page
 * their sidebar does not contain.
 *
 * `canBeRostered` is the predicate those three already share, and the sidebar
 * with them. It is read here rather than restated, because the last time this
 * rule was spelled out by hand the menu began offering admins three pages that
 * could never hold anything. This is the fifth caller; the whole point of the
 * function is that there is no fifth opinion.
 *
 * It is not a permission, and no permission set changes it. The exclusion is
 * about what the ENGINE will consider, not about authority — an admin holds
 * every permission in the catalogue and is still not on the rota.
 *
 * ## What is deliberately NOT here yet
 *
 * Three questions that need a specific shift or assignment resolved out of
 * free text — "who could cover Friday's bar shift", "who is free on the 14th",
 * "why was Alex picked for this one". Every one of them is a good question and
 * every one of them turns on entity resolution: deciding WHICH shift somebody
 * meant from a sentence. That is where a rostering assistant would go wrong,
 * and it would go wrong invisibly — the answer about the wrong shift looks
 * exactly like the answer about the right one.
 *
 * They belong on a button beside the shift, where the id is a fact rather than
 * an inference. Same questions, same services, no guessing. Filed rather than
 * fudged.
 */

import { canBeRostered } from "@/lib/role-config";

/** Every question the assistant can answer, plus the two non-answers. */
export const ASSISTANT_INTENTS = [
  // ── About you. No permission: reading your own rota is not a privilege. ──
  {
    id: "my_next_shift",
    scope: "self",
    permission: null,
    /** Shown to the model, so it must describe the question a person would ask. */
    describes: "when the user's own next shift is",
    /** Offered as a starting chip. */
    prompt: "When is my next shift?",
    keywords: ["next shift", "when am i working", "when do i work", "am i working"],
  },
  {
    id: "my_week",
    scope: "self",
    permission: null,
    describes: "what the user is rostered for over the coming week",
    prompt: "What am I rostered for this week?",
    keywords: ["my week", "rostered", "my shifts", "my schedule", "this week"],
  },
  {
    id: "my_pending",
    scope: "self",
    permission: null,
    describes: "which of the user's own shifts are waiting for them to accept or decline",
    prompt: "Is anything waiting on my response?",
    keywords: ["waiting on", "need to accept", "pending", "respond", "awaiting"],
  },
  {
    id: "my_hours",
    scope: "self",
    permission: null,
    describes: "how many hours the user themselves is scheduled for or has worked",
    prompt: "How many hours am I down for?",
    keywords: ["my hours", "how many hours am i", "hours am i working"],
  },

  // ── About the organisation. Each names the permission that owns the data. ──
  {
    id: "needs_attention",
    scope: "organisation",
    permission: "reports:view",
    describes: "what in the organisation needs the user's attention right now",
    prompt: "What needs my attention?",
    keywords: ["needs attention", "attention", "what should i", "anything urgent", "problems"],
  },
  {
    id: "unfilled_shifts",
    scope: "organisation",
    permission: "reports:view",
    describes: "which upcoming shifts do not yet have enough staff on them",
    prompt: "Which shifts are unfilled?",
    keywords: ["unfilled", "understaffed", "short staffed", "need staff", "gaps"],
  },
  {
    id: "member_hours",
    scope: "organisation",
    permission: "reports:view",
    describes: "how many hours a NAMED member of staff has worked or is scheduled for",
    prompt: "How many hours has someone worked?",
    keywords: ["hours has", "hours did", "worked this week"],
  },

  // ── Neither of these touches data. ──
  {
    id: "help",
    scope: "none",
    permission: null,
    describes: "how to do something in the product, with no reference to actual data",
    prompt: "How do I create a recurring shift?",
    keywords: ["how do i", "how to", "where do i find", "what does"],
  },
  {
    /*
     * A first-class answer, not a failure.
     *
     * An assistant that admits it did not understand is more useful than one
     * that fluently answers a question nobody asked — and in a product where
     * the answer is a shift time, the fluent wrong answer is the dangerous
     * one. This is what the classifier must return when nothing above fits,
     * and the prompt says so explicitly rather than leaving it as the least
     * bad option.
     */
    id: "unknown",
    scope: "none",
    permission: null,
    describes: "anything that is not clearly one of the above",
    prompt: "",
    keywords: [],
  },
] as const;

export type AssistantIntentId = (typeof ASSISTANT_INTENTS)[number]["id"];
export type AssistantIntentScope = (typeof ASSISTANT_INTENTS)[number]["scope"];

export const ASSISTANT_INTENT_IDS: readonly string[] = ASSISTANT_INTENTS.map(
  (i) => i.id
);

/** The permission that opens the assistant at all, before any question. */
export const ASSISTANT_PERMISSION = "assistant:use";

export function findIntent(id: string) {
  return ASSISTANT_INTENTS.find((i) => i.id === id);
}

/**
 * Is `id` something the model is allowed to have said?
 *
 * The classifier's output is untrusted input like any other. A provider that
 * returns `"drop_all_tables"`, or `"my_hours "` with a stray space, or a
 * sentence of prose, must land on `unknown` rather than anywhere near a
 * lookup.
 */
export function isAssistantIntentId(id: unknown): id is AssistantIntentId {
  return typeof id === "string" && ASSISTANT_INTENT_IDS.includes(id);
}

/**
 * May this caller ask this question?
 *
 * Checked on the SERVER against the intent the classifier returned, never
 * against the intent the user appeared to type. The two differ exactly when
 * something has gone wrong, which is when this matters.
 */
export function isIntentAllowed(
  id: AssistantIntentId,
  permissions: ReadonlySet<string>,
  /** The caller's SYSTEM role. Decides the self questions, which no permission does. */
  role: string | undefined | null
): boolean {
  const intent = findIntent(id);
  if (!intent) return false;

  /*
   * Refused for somebody who is never rostered, rather than answered with
   * "you have no shifts".
   *
   * Those are different claims. "No shifts" says the rota is empty this week
   * and might not be next week; the truth for an admin is that they are not on
   * the rota at all and never will be. An assistant that reports the first
   * when the second is true is not being tactful, it is being wrong.
   */
  if (intent.scope === "self" && !canBeRostered(role)) return false;

  if (!intent.permission) return true;
  return permissions.has(intent.permission);
}

/**
 * The questions this caller may actually ask, for the prompt and the chips.
 *
 * The model is only ever shown the intents the caller is permitted to reach.
 * That is not the enforcement — `isIntentAllowed` is, and it runs afterwards
 * regardless — but it removes the most likely cause of a refusal, which is the
 * model helpfully picking a question the asker was never going to be allowed.
 */
export function intentsFor(
  permissions: ReadonlySet<string>,
  role: string | undefined | null
) {
  return ASSISTANT_INTENTS.filter(
    (i) => i.id !== "unknown" && isIntentAllowed(i.id, permissions, role)
  );
}

/**
 * A keyword match, and whether it is trustworthy enough to act on alone.
 */
export interface KeywordClassification {
  id: AssistantIntentId;
  /**
   * True when this answer is good enough to skip the provider entirely.
   *
   * Not a probability and not a score — a rule, so it can be reasoned about
   * and tested. See `classifyByKeywords`.
   */
  certain: boolean;
}

/**
 * The shortest keyword that may decide a question on its own.
 *
 * Below this, a match is a coincidence waiting to happen: "pending" appears in
 * plenty of sentences that are not about pending shifts. Above it, the phrase
 * is specific enough that a single unambiguous hit is as good an answer as a
 * model would give — and the phrasing fixture is what keeps that true.
 */
const CERTAIN_KEYWORD_LENGTH = 8;

/**
 * Classification without a provider.
 *
 * ## Two jobs, and the second one is new
 *
 * This began as the fallback for both providers being unreachable — the same
 * arrangement as `FallbackRanker` behind the allocation providers. It is now
 * also the FIRST thing tried, because the assistant was paying a provider to
 * classify sentences the product itself had written: every suggested question
 * in the panel is one of the `prompt` strings below, and each one resolves
 * here with certainty.
 *
 * That is the whole saving. The model keeps the job it is good at — paraphrase,
 * odd wording, questions nobody anticipated — and stops being asked to read
 * back a string we handed the user thirty seconds earlier.
 *
 * ## What "certain" means
 *
 * Exactly ONE intent matched, on a keyword of at least
 * {@link CERTAIN_KEYWORD_LENGTH} characters.
 *
 * Both halves are load-bearing. Two intents matching means the sentence is
 * genuinely ambiguous — "what shifts am i working this week" reaches both
 * `my_next_shift` and `my_week` — and guessing between them is exactly the
 * confident-wrong-answer this design exists to avoid, so it goes to the model.
 * A short keyword matching alone is a coincidence, not a reading.
 *
 * Longest keyword first, so "how many hours am i" is not beaten by "how do i".
 */
export function classifyByKeywords(text: string): KeywordClassification {
  const haystack = text.toLowerCase();

  const matches = ASSISTANT_INTENTS.flatMap((intent) =>
    intent.keywords
      .filter((k) => haystack.includes(k))
      .map((k) => ({ id: intent.id, length: k.length }))
  ).sort((a, b) => b.length - a.length);

  const best = matches[0];
  if (!best) return { id: "unknown", certain: false };

  const distinctIntents = new Set(matches.map((m) => m.id));

  return {
    id: best.id,
    certain: distinctIntents.size === 1 && best.length >= CERTAIN_KEYWORD_LENGTH,
  };
}
