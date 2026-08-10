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
    keywords: ["waiting on me", "need to accept", "pending", "respond", "awaiting"],
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
    keywords: ["needs attention", "what should i", "anything urgent", "problems"],
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
  permissions: ReadonlySet<string>
): boolean {
  const intent = findIntent(id);
  if (!intent) return false;
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
export function intentsFor(permissions: ReadonlySet<string>) {
  return ASSISTANT_INTENTS.filter(
    (i) => i.id !== "unknown" && isIntentAllowed(i.id, permissions)
  );
}

/**
 * Classification without a provider.
 *
 * The same shape as `FallbackRanker` behind the allocation providers and
 * `fallbackParse` behind the task parser: when Groq and Gemini are both
 * unreachable, the feature degrades instead of disappearing. Keyword matching
 * is a poor classifier and a fine safety net — it answers the plainly-phrased
 * question and returns `unknown` for everything else, which is the honest
 * outcome rather than a guess.
 *
 * Longest keyword first, so "how many hours am i" is not beaten by "how do i".
 */
export function classifyByKeywords(text: string): AssistantIntentId {
  const haystack = text.toLowerCase();

  const matches = ASSISTANT_INTENTS.flatMap((intent) =>
    intent.keywords
      .filter((k) => haystack.includes(k))
      .map((k) => ({ id: intent.id, length: k.length }))
  ).sort((a, b) => b.length - a.length);

  return matches[0]?.id ?? "unknown";
}
