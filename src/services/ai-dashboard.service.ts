/**
 * AI Dashboard Service (Control Layer)
 *
 * Generates AI-powered dashboard insights including:
 * - Natural language workforce summary (US-67)
 * - Proactive staffing alerts (US-68)
 * - Rejection pattern analysis (US-70)
 * - Ranked actionable recommendations (Phase 8)
 *
 * Uses the same AI provider infrastructure (Groq/Gemini/fallback)
 * as the allocation service. All insights are advisory — the
 * admin always has final decision authority.
 */
/*
 * `hasApiKey` and `aiTimeoutSignal`, not `if (key)` and `AbortSignal.timeout`.
 *
 * `ai-limits.ts` credits this file as the one that got the timeout right, and
 * this file was then the only one never to adopt the helper extracted from it.
 * The timeout was the same behaviour spelled differently; the key check was
 * not. `if (groqKey)` passes for a key of a single space, which sends
 * `Bearer " "` to Groq and buys a real round-trip that has to time out before
 * the fallback can run — the exact failure `hasApiKey` was written for.
 */
import { aiTimeoutSignal, hasApiKey } from "@/lib/ai-limits";
import { TaskRepository } from "@/repositories/task.repository";
import { startOfDayInTimeZone } from "@/lib/timezone";
import { MembershipRepository } from "@/repositories/membership.repository";
import { SettingsRepository } from "@/repositories/settings.repository";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { CertificationRepository } from "@/repositories/certification.repository";
import { DepartmentRepository } from "@/repositories/department.repository";
import type { AIProviderName } from "@/services/ai-provider";
import { ReportingService, type NeedsAttentionItem } from "@/services/reporting.service";
import { SubscriptionService } from "@/services/subscription.service";
import { countOccupied } from "@/lib/assignment-status";

/**
 * Reads the model's reply, or null if it is not usable.
 *
 * Tolerant of the fenced-JSON habit small models have; strict about the two
 * fields it needs. Anything else is treated as no answer, because the caller
 * showing nothing is always safe and showing a half-parsed answer is not.
 */
function parsePriorityReply(content: string): { entityId: string; why: string } | null {
  try {
    const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (typeof parsed?.entityId !== "string" || !parsed.entityId.trim()) return null;
    // Typed, not coerced. `String({text: "…"})` is "[object Object]", which has
    // no digit and is comfortably under the length cap, so it would have passed
    // every check and printed under the START HERE row.
    const why = typeof parsed.why === "string" ? parsed.why : "";
    return { entityId: parsed.entityId.trim(), why };
  } catch {
    return null;
  }
}

/** Sentences longer than this are a paragraph, and the row has one line. */
const MAX_PRIORITY_REASON = 200;

/**
 * The model's justification, or null if it cannot be shown as-is.
 *
 * Rejected outright when it contains a digit. Every number on this panel comes
 * from the database, and a model repeating one is either saying what the row
 * above already says or contradicting it — which is exactly what happened
 * before ("Only 2/3 staff are assigned" under an alert reading 0/3). Dropping
 * the sentence costs nothing: the ordering was the contribution.
 *
 * Rejecting rather than stripping, because a sentence with its figures cut out
 * reads as damaged and often changes meaning.
 */
function sanitisePriorityReason(why: string): string | null {
  const trimmed = why.trim();
  if (!trimmed) return null;
  if (/\d/.test(trimmed)) return null;
  if (trimmed.length > MAX_PRIORITY_REASON) return null;
  return trimmed;
}

interface DashboardData {
  activeStaff: number;
  totalTasks: number;
  openTasks: number;
  inProgressTasks: number;
  unassignedTasks: number;
  understaffedTasks: { title: string; department: string; required: number; assigned: number; needed: number; taskId: string }[];
  staffNearLimit: { name: string; hours: number }[];
  recentRejections: { staffName: string; membershipId: string; userId: string; count: number; reasons: string[] }[];
  completedToday: number;
  pendingCertifications: number;
  departmentCount: number;
  departments: { name: string; taskCount: number; memberCount: number }[];
  maxHours: number;
}
/**
 * The smart engine's one contribution to the action list: which item to do
 * first, and why.
 *
 * ## Why this replaced a recommendation list
 *
 * The dashboard used to compute deterministic alerts from the data and then
 * hand the SAME data to a model asking for "3-5 recommendations". It had
 * nothing to add, so it restated the alerts in worse prose — and when it
 * volunteered a figure it sometimes got it wrong, printing "Only 2/3 staff are
 * assigned" directly beneath an alert reading "0/3 assigned".
 *
 * That is structural, not a prompt bug. A figure the model repeats is one we
 * already computed: it can be redundant or it can be wrong, and there is no
 * third outcome where it helps.
 *
 * Choosing between twelve competing calls on a manager's morning is the one
 * thing the rules genuinely cannot do — it weighs urgency against who is
 * actually free, which no threshold expresses. So the model orders; it never
 * enumerates and it never counts.
 */
export interface PriorityCall {
  /** entityId of the chosen alert, echoed back only after validation. */
  entityId: string;
  /** The chosen alert's own message, taken from our data and never the model's. */
  message: string;
  /**
   * The model's one-line justification, or null when it offered none we could
   * safely show. Null is a normal outcome: the ordering is the contribution,
   * and a missing sentence costs nothing, while an unverifiable claim costs
   * trust in the row above it.
   */
  reason: string | null;
  /**
   * Which strategy chose this call.
   *
   * This read "Never algorithmic — there is no fallback here", and that was
   * true and was the gap. Every other AI surface in the product degrades:
   * allocation falls to `FallbackRanker`, auto-schedule to
   * `generateAlgorithmic`, the parser and the assistant to keywords. This one
   * went blank — beside a list that had already ranked the same alerts by
   * severity.
   *
   * So "algorithmic" now means: both providers were unreachable, and the most
   * serious alert was chosen by rule. Blunter than the model, which weighs
   * urgency against who is actually free — but a blunt answer beats an empty
   * panel, and the label is what stops the two being confused.
   *
   * The feedback-themes panel deliberately had NO equivalent, and the
   * distinction is the interesting one: choosing between structured alerts is
   * something rules can approximate. Reading prose is not, so a counted
   * fallback there would have been a different feature wearing its name.
   *
   * That panel has since been removed — see the backlog. It was handed the
   * decline REASON inside each numbered line and dutifully read the enum back
   * as the theme, so the one surface built to do what SQL cannot was a GROUP BY
   * with a model in the middle. The rule survives it: a model may order our
   * sentences, never write them.
   */
  provider: AIProviderName;
}

export interface PriorityCallResponse {
  /** Null whenever no model answered, or nothing was worth prioritising. */
  call: PriorityCall | null;
  /**
   * The engine was asked and could not answer.
   *
   * `call: null` alone meant five different things — fewer than two alerts, no
   * key configured, a rate limit, a timeout, and a hallucinated id — and the
   * dashboard dropped the badge identically for all of them. Nothing false was
   * stated, but a manager who had come to rely on it had no way to tell "the
   * engine has no strong opinion today" from "the engine stopped answering a
   * fortnight ago".
   *
   * It no longer implies `call: null`. A provider outage now still produces a
   * call — chosen by severity rather than by a model — and this flag is what
   * keeps the two distinguishable. Without it, a fortnight of outage would read
   * as a fortnight of ordinary advice that happened to be blunter than usual.
   */
  unavailable?: boolean;
}

/*
 * The bound and its reasoning now live in `@/lib/ai-limits`, because every
 * other provider call in the codebase needed the same fix and had not had it.
 */

/**
 * Logs a provider response that came back but was not ok.
 *
 * These were silent: only THROWN errors reached `console.error`, so a revoked
 * key (401) or a rate limit (429) fell through to the next provider and, if
 * that was unset too, produced an empty panel indistinguishable from "this org
 * has no feedback". That is exactly the silent degradation the provenance
 * trail was built to end.
 */
async function logProviderFailure(
  surface: string,
  provider: string,
  response: Response
) {
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 200);
  } catch {
    /* body already consumed or unreadable — the status is the useful part */
  }
  console.error(
    `[${surface}] ${provider} returned ${response.status} ${response.statusText}: ${detail}`
  );
}

export class AIDashboardService {
  private taskRepo = new TaskRepository();
  private membershipRepo = new MembershipRepository();
  private settingsRepo = new SettingsRepository();
  private assignmentRepo = new TaskAssignmentRepository();
  private certRepo = new CertificationRepository();
  private departmentRepo = new DepartmentRepository();
  private reportingService = new ReportingService();
  private subscriptionService = new SubscriptionService();

  /**
   * System prompt for the priority call.
   *
   * Two rules carry the whole design. The model may not invent an id, because
   * an id it made up points at nothing; and it may not use figures, because
   * every figure on this page was already computed from the database and a
   * model repeating one can only be redundant or wrong.
   */
  private priorityPrompt = `You are helping a shift manager decide what to do first.
You will be given a numbered list of things needing attention.
Choose the SINGLE most important one and explain the choice in one short sentence.

Respond with ONLY valid JSON:
{ "entityId": "<the id shown in brackets for the item you chose>", "why": "<one short sentence>" }

RULES:
- entityId MUST be copied exactly from the list. Never invent one.
- "why" must NOT contain any numbers or figures. The list already states them,
  and repeating one you cannot verify is worse than saying nothing.
- Justify the ORDERING — urgency, knock-on effects, how hard it will be to fix
  later — not the facts, which the reader can already see.
- One sentence. No preamble.`;

  // ================================================================
  // Priority call
  // ================================================================

  /**
   * Asks the model which of the outstanding items to do first.
   *
   * Returns `{ call: null }` whenever there is no honest answer: no model
   * configured, fewer than two items (nothing to order), or a reply that
   * failed validation. Nothing is fabricated to fill the space — the previous
   * design's algorithmic "recommendations" were restatements of the alerts
   * they sat beside, and a placeholder is worse than an absence.
   */
  async getPriorityCall(
    organizationId: string,
    /** Manager scope. null/undefined = unrestricted (company admin). */
    departmentIds?: string[] | null
  ): Promise<PriorityCallResponse> {
    /*
     * `advanced_analytics`, above Free from 2026-08-14.
     *
     * Returns the ordinary empty answer rather than throwing. Every other
     * "no honest answer" case in this method — no model configured, fewer
     * than two items, a reply that failed validation — is already
     * `{ call: null }`, and its one caller renders nothing for it. A plan
     * refusal is the same shape of nothing, and throwing here would turn a
     * Free dashboard's optional panel into a 500 on every load.
     *
     * The route still returns the panel's data only to entitled callers; this
     * is the layer that guarantees no provider call is spent either way.
     */
    if (
      !(await this.subscriptionService.canUseFeature(
        organizationId,
        "advanced_analytics"
      ))
    ) {
      return { call: null };
    }

    // Recomputed here rather than accepted from the client. The dashboard
    // already holds this list, but trusting a posted copy would let a caller
    // choose what the model comments on. It is the same bounded computation
    // the dashboard route runs.
    const alerts = await this.reportingService.getNeedsAttention(
      organizationId,
      // getNeedsAttention takes `string[] | undefined`; null and undefined
      // both mean unrestricted here, so they collapse to the same argument.
      departmentIds ?? undefined
    );

    // Only alerts that identify something can be pointed back at.
    const candidates = alerts.filter(
      (a: NeedsAttentionItem): a is NeedsAttentionItem & { entityId: string } =>
        Boolean(a.entityId)
    );

    // One thing to do is not a prioritisation problem.
    if (candidates.length < 2) return { call: null };

    const prompt = candidates
      .map((a, i) => `${i + 1}. [${a.entityId}] (${a.severity}) ${a.message}`)
      .join("\n");

    const answer = await this.callAIForPriority(prompt);

    /*
     * Asked, and no provider answered — distinct from the early return above,
     * where there was nothing worth asking about.
     *
     * The alerts arrive already ranked: `getNeedsAttention` assigns each one a
     * severity and pushes them in a deliberate order. So the deterministic
     * answer to "what should I look at first" is sitting in the argument this
     * method was given, and returning nothing was throwing it away.
     *
     * `unavailable` stays true. It has not stopped being true — the engine was
     * asked and did not answer — and the panel needs to keep saying so, or a
     * fortnight of provider outage reads as a fortnight of blunt-but-fine
     * advice.
     */
    if (!answer) {
      const bySeverity = { danger: 0, warning: 1, info: 2 } as const;
      /*
       * Sorted, not searched, and the stability matters: `Array.sort` is
       * stable, so alerts of equal severity keep the order `getNeedsAttention`
       * chose — which is itself deliberate, insights first. A `find` for the
       * first danger would have been equivalent today and would have quietly
       * stopped being equivalent the moment a fourth severity appeared.
       */
      const top = [...candidates].sort(
        (a, b) => bySeverity[a.severity] - bySeverity[b.severity]
      )[0];

      return {
        call: {
          entityId: top.entityId,
          message: top.message,
          // No sentence, because there is no one to write it. Null is already
          // a normal outcome here — the ordering is the contribution.
          reason: null,
          provider: "algorithmic",
        },
        unavailable: true,
      };
    }

    const chosen = candidates.find((a) => a.entityId === answer.entityId);
    // An id we did not send. Discarded rather than resolved — a hallucinated
    // id is the one failure mode that would put the wrong row at the top.
    if (!chosen) return { call: null };

    return {
      call: {
        entityId: chosen.entityId,
        // Our message, never the model's. The model chose the row; it does
        // not get to restate what the row says.
        message: chosen.message,
        reason: sanitisePriorityReason(answer.why),
        provider: answer.provider,
      },
    };
  }

  /** Groq, then Gemini. No algorithmic fallback — see getPriorityCall. */
  private async callAIForPriority(
    prompt: string
  ): Promise<{ entityId: string; why: string; provider: AIProviderName } | null> {
    const groqKey = process.env.GROQ_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;

    if (hasApiKey(groqKey)) {
      try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groqKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "openai/gpt-oss-20b",
            messages: [
              { role: "system", content: this.priorityPrompt },
              { role: "user", content: prompt },
            ],
            temperature: 0,
            max_tokens: 200,
          }),
          signal: aiTimeoutSignal(),
        });
        if (response.ok) {
          const result = await response.json();
          const parsed = parsePriorityReply(result.choices?.[0]?.message?.content ?? "");
          if (parsed) return { ...parsed, provider: "groq" };
        } else {
          await logProviderFailure("Priority Call", "Groq", response);
        }
      } catch (error) {
        console.error("[Priority Call] Groq failed:", error);
      }
    }

    if (hasApiKey(geminiKey)) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                { parts: [{ text: `${this.priorityPrompt}\n\n${prompt}` }] },
              ],
              generationConfig: { temperature: 0, maxOutputTokens: 200 },
            }),
            signal: aiTimeoutSignal(),
          }
        );
        if (response.ok) {
          const result = await response.json();
          const parsed = parsePriorityReply(
            result.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
          );
          if (parsed) return { ...parsed, provider: "gemini" };
        } else {
          await logProviderFailure("Priority Call", "Gemini", response);
        }
      } catch (error) {
        console.error("[Priority Call] Gemini failed:", error);
      }
    }

    return null;
  }

  // ================================================================
  // Data Gathering (shared by both endpoints)
  // ================================================================

  /**
   * Gathers all data needed for dashboard analysis.
   */
  /**
   * Collects the raw picture the model reasons over.
   *
   * `departmentIds` was missing until 2026-08-02, and the consequence was not
   * abstract: the alerts and recommendations built from this data embed staff
   * NAMES and task TITLES. A manager scoped to one department was shown, in
   * plain language, who elsewhere in the company was near their hour limit and
   * which of another team's shifts were understaffed — and the same org-wide
   * detail was sent to Groq or Gemini in the prompt.
   *
   * Filtering is in memory rather than at the query, because both repository
   * calls already load everything this needs — `findByOrgId` includes each
   * membership's departments — and pushing the scope into the queries would
   * mean touching two repositories for no behavioural gain.
   *
   * Public rather than private so the counts can be asserted directly. They are
   * the premise of everything downstream — the panel, the alerts and the model
   * prompt — and a test that can only read the prose those counts produce
   * cannot tell a wrong number from a wrong sentence.
   */
  async gatherDashboardData(
    organizationId: string,
    departmentIds?: string[] | null
  ): Promise<DashboardData> {
    /** null/undefined = unrestricted. An empty array means "no departments". */
    const scope = departmentIds == null ? null : new Set(departmentIds);

    const settings = await this.settingsRepo.getOrCreate(organizationId);
    const members = await this.membershipRepo.findByOrgId(organizationId);
    const activeStaff = members
      .filter((m) => m.status === "active" && m.role !== "company_admin")
      .filter(
        (m) =>
          scope === null ||
          m.departmentMemberships.some((dm) => scope.has(dm.department.id))
      );

    const allTasks = await this.taskRepo.findByOrganizationId(organizationId);
    // A task with no department belongs to nobody as far as scope goes — the
    // same rule AccessService.isTaskInScope applies.
    const tasks =
      scope === null
        ? allTasks
        : allTasks.filter((t) => t.departmentId !== null && scope.has(t.departmentId));
    const openTasks = tasks.filter((t) => t.status === "open");
    const inProgressTasks = tasks.filter((t) => t.status === "in_progress");

    /*
     * Counted with the shared rule, not with `assignments.length`.
     *
     * `findByOrganizationId` includes assignments with no status filter, so
     * the raw length counts rows that were rejected or withdrawn. A three-
     * person shift everyone turned down read as `3`, which made it neither
     * unassigned nor understaffed — it disappeared from this panel entirely,
     * while `getUnderstaffedTasks` said it needed three people. Same data,
     * same moment, two answers.
     *
     * It matters more here than on a screen: these figures go into the prompt,
     * so a wrong count does not merely display wrong, it becomes the premise
     * of a recommendation.
     */
    const occupiedFor = new Map(
      openTasks.map((t) => [t.id, countOccupied(t.assignments)])
    );
    const unassignedTasks = openTasks.filter((t) => occupiedFor.get(t.id) === 0);
    const understaffedTasks = openTasks
      .filter((t) => {
        const taken = occupiedFor.get(t.id) ?? 0;
        return taken > 0 && taken < t.requiredHeadcount;
      })
      .map((t) => {
        const taken = occupiedFor.get(t.id) ?? 0;
        return {
          title: t.title,
          department: t.department?.name || "No department",
          required: t.requiredHeadcount,
          assigned: taken,
          needed: t.requiredHeadcount - taken,
          taskId: t.id,
        };
      });

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const staffNearLimit: { name: string; hours: number }[] = [];

    for (const staff of activeStaff) {
      const assignments = await this.assignmentRepo.findWorkedSince(
        staff.id,
        oneDayAgo
      );

      let hours = 0;
      for (const a of assignments) {
        if (a.clockInTime && a.clockOutTime) {
          hours += (a.clockOutTime.getTime() - a.clockInTime.getTime()) / (1000 * 60 * 60);
        }
      }

      if (hours >= settings.workingDayHours * 0.75) {
        staffNearLimit.push({
          name: staff.user.name || staff.user.email,
          hours,
        });
      }
    }

    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rejections = await this.assignmentRepo.findRecentRejections(
      organizationId,
      oneWeekAgo
    );

    // Rejections come back org-wide. `activeStaff` is already scoped, so it is
    // the authoritative list of who this caller may be told about — a rejection
    // by someone in another department must not surface as a "pattern".
    const visibleMembershipIds = new Set(activeStaff.map((m) => m.id));

    const rejectionMap: Record<string, { staffName: string; membershipId: string; userId: string; count: number; reasons: string[] }> = {};
    for (const r of rejections) {
      if (scope !== null && !visibleMembershipIds.has(r.membershipId)) continue;
      const key = r.membershipId;
      if (!rejectionMap[key]) {
        rejectionMap[key] = {
          staffName: r.membership.user.name || r.membership.user.email,
          membershipId: r.membershipId,
          userId: r.membership.user.id,
          count: 0,
          reasons: [],
        };
      }
      rejectionMap[key].count++;
      if (r.rejectionReason && !rejectionMap[key].reasons.includes(r.rejectionReason)) {
        rejectionMap[key].reasons.push(r.rejectionReason);
      }
    }

    const recentRejections = Object.values(rejectionMap).filter((r) => r.count >= 2);

    // setHours() uses the runtime's zone: on Vercel that is UTC, i.e. 08:00
    // Singapore, so everything completed before 8am local was omitted — and the
    // wrong figure was then handed to the model as ground truth.
    const todayStart = startOfDayInTimeZone();
    const completedToday = await this.assignmentRepo.countCompletedSince(
      organizationId,
      todayStart
    );

    const pendingCertifications =
      await this.certRepo.countPendingVerification(organizationId);

    const allDepartments = await this.departmentRepo.findActiveWithCounts(
      organizationId
    );
    const departments =
      scope === null
        ? allDepartments
        : allDepartments.filter((d) => scope.has(d.id));

    const deptStats = departments.map((d) => ({
      name: d.name,
      taskCount: d._count.tasks,
      memberCount: d._count.departmentMemberships,
    }));

    return {
      activeStaff: activeStaff.length,
      totalTasks: openTasks.length + inProgressTasks.length,
      openTasks: openTasks.length,
      inProgressTasks: inProgressTasks.length,
      unassignedTasks: unassignedTasks.length,
      understaffedTasks,
      staffNearLimit,
      recentRejections,
      completedToday,
      pendingCertifications,
      departmentCount: departments.length,
      departments: deptStats,
      maxHours: settings.workingDayHours,
    };
  }
}