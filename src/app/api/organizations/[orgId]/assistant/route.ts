/**
 * Assistant API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/assistant
 *
 * Asks one question and returns one answer. Reads only.
 *
 * ## The gates, in the order they run
 *
 * 1. **Session.** No session, no answer.
 * 2. **Plan, then permission.** `requirePermission` checks the plan BEFORE the
 *    permission, because `assistant:use` is mapped to the `assistant` gated
 *    feature — so a Free organisation is told it needs Pro rather than told it
 *    lacks a permission its admin would then go and grant to no effect.
 * 3. **Rate limit, per user.** Not per organisation: a limit shared across a
 *    fifty-person tenant would let one person's runaway loop silence everybody
 *    else's assistant, and the spend is attributable to a person either way.
 * 4. **Per QUESTION.** Whether this caller may ask the particular thing the
 *    classifier decided they asked is settled inside the service, against the
 *    permission that owns that data. The gate above opens the panel; it does
 *    not open every question in it.
 *
 * ## Why the model's output is never trusted here
 *
 * The route hands the service a sentence and receives an answer built from
 * database values. It never forwards model output to the client, and the model
 * never sees the database. That ordering is the whole security story: the
 * provider is an interpreter of the question, not a fetcher of the answer.
 *
 * Rate limit tier: strict. Every call costs a provider request, and unlike the
 * other AI surfaces the user controls how often it happens.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AssistantService } from "@/services/assistant.service";
import { AccessService } from "@/services/access.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { validationErrorResponse } from "@/lib/api-utils";
import { rateLimit } from "@/lib/rate-limit";
import { MAX_PROMPT_INPUT } from "@/lib/ai-prompt-safety";

const assistantService = new AssistantService();
const accessService = new AccessService();

/** Questions per minute, per user. */
const ASSISTANT_LIMIT = 10;

const askSchema = z.object({
  /*
   * Bounded at the same length the sanitiser truncates to. Stated as a refusal
   * rather than a silent trim: a question cut off at 500 characters would be
   * answered as though it were the whole question, and the asker would never
   * know which half was read.
   */
  question: z.string().trim().min(1, "Ask a question").max(MAX_PROMPT_INPUT),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const gate = await requirePermission(user.id, orgId, "assistant:use");
    if (!gate.ok) return gate.response;

    const limit = rateLimit(`assistant:${user.id}`, ASSISTANT_LIMIT);
    if (!limit.success) {
      return NextResponse.json(
        {
          error: `That is a lot of questions at once. Try again in ${Math.ceil(limit.resetIn / 1000)} seconds.`,
        },
        { status: 429 }
      );
    }

    const body = await request.json();
    const parsed = askSchema.safeParse(body);
    if (!parsed.success) return validationErrorResponse(parsed.error);

    /*
     * Re-read rather than reusing `gate.membership`, because this needs the
     * department memberships for scope and the guard's membership is loaded
     * for a different question. One query, and it is the query the answer
     * needs.
     */
    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership) return unauthorizedResponse();

    const answer = await assistantService.ask(parsed.data.question, {
      userId: user.id,
      membershipId: membership.id,
      organizationId: orgId,
      membership,
      permissions: accessService.permissionsFor(membership),
    });

    return NextResponse.json(answer);
  } catch (error) {
    console.error("[Assistant Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
