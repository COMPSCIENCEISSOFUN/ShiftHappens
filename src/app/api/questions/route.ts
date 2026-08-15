/**
 * Ask a Question API (Boundary Layer)
 * POST /api/questions — from the landing page, signed in or not
 *
 */
import { NextRequest, NextResponse } from "next/server";

import { rateLimit } from "@/lib/rate-limit";
import { askQuestionSchema } from "@/lib/validations";
import { QuestionService } from "@/services/question.service";

const questions = new QuestionService();

/** Questions per minute, per address. */
const ASK_LIMIT = 3;

/**
 * Who is asking, as far as anyone can tell.
 *
 * Behind a proxy every request carries the same socket address, so
 * `x-forwarded-for` is the only thing that distinguishes callers. It is
 * spoofable, which is why this bounds a nuisance rather than guarding anything:
 * nothing here is authorisation.
 */
function callerKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

export async function POST(request: NextRequest) {
  try {
    const limit = rateLimit(`ask:${callerKey(request)}`, ASK_LIMIT);
    if (!limit.success) {
      return NextResponse.json(
        {
          error: `That was not sent — too many questions at once. Try again in ${Math.ceil(limit.resetIn / 1000)} seconds.`,
        },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(limit.resetIn / 1000)) },
        }
      );
    }

    const parsed = askQuestionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // Filled means a script. Answered as though it worked.
    if (parsed.data.website) {
      return NextResponse.json({ received: true }, { status: 201 });
    }

    await questions.ask(parsed.data);
    return NextResponse.json({ received: true }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not send that";
    const known =
      message.startsWith("Please write") ||
      message.startsWith("A question must be") ||
      message.startsWith("That email") ||
      message.startsWith("That does not look");
    if (known) return NextResponse.json({ error: message }, { status: 400 });

    console.error("[POST /api/questions]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
