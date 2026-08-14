/**
 * Task Parser API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/tasks/parse
 * 
 * Parses natural language into structured task data.
 * Admin types a sentence, AI extracts task fields.
 * The result pre-fills the create form for review.
 */
import { NextRequest, NextResponse } from "next/server";
import { AITaskParserService } from "@/services/ai-task-parser.service";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor } from "@/lib/department-scope";
import { planRefusal } from "@/lib/api-utils";

const parser = new AITaskParserService();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    // Suspension gate, missing here while every comparable sibling had one.
    // No database write, but it spends the organisation's Groq/Gemini quota. The other two AI-spending POSTs are both gated.
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const gate = await requirePermission(user.id, orgId, "tasks:create");
    if (!gate.ok) return gate.response;

    const body = await request.json();
    const { text } = body;

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return NextResponse.json({ error: "Text is required" }, { status: 400 });
    }

    /*
     * The caller's scope, resolved from the membership the guard already
     * loaded — the same expression the `tasks` POST beside this uses to refuse
     * an out-of-scope department.
     *
     * Passing it here means the two agree by construction rather than by
     * coincidence: the parser cannot suggest a department the create route
     * would reject, because it is never shown one.
     */
    const parsed = await parser.parseTaskDescription(
      text.trim(),
      orgId,
      departmentScopeFor(gate.membership)
    );
    return NextResponse.json(parsed);
  } catch (error) {
    /*
     * The plan first. `ai_task_create` is enforced inside the parser service
     * rather than by the route guard, because the guard here checks
     * `tasks:create` — a permission every plan keeps, since typing a task in
     * by hand is core workforce management. Without this branch that refusal
     * arrived as a 500.
     */
    const plan = planRefusal(error);
    if (plan) return plan;

    console.error("[Task Parser Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}