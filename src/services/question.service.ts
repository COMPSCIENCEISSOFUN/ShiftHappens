/**
 * Asked questions (Control layer).
 *
 * ## The one public write in the application
 *
 * Every other write requires a session. This one cannot: the whole point is to
 * hear from people who have not signed up, and they are exactly who a public
 * FAQ is written for. That makes this the only endpoint a stranger can put a
 * row in the database with, so the limits live here rather than in the form —
 * a form is a suggestion, and a caller with curl does not read it.
 *
 * ## Nothing asked is ever published
 *
 * Answering a question means CREATING an FAQ entry, with the question reworded
 * by the platform admin. The stored text is shown to the admin and to nobody
 * else, so no stranger's words reach the marketing site, and the FAQ keeps
 * reading in one voice.
 */
import { QuestionRepository } from "@/repositories/question.repository";
import { MembershipRepository } from "@/repositories/membership.repository";

export const QUESTION_MAX_LENGTH = 1000;
export const QUESTION_NAME_MAX = 120;
export const QUESTION_EMAIL_MAX = 254;
export const QUESTION_PAGE_SIZE = 25;

/** How far back the "asked recently" count looks. */
export const QUESTION_WINDOW_DAYS = 90;

export interface AskQuestionInput {
  body: string;
  email?: string;
  name?: string;
}

export class QuestionService {
  private questionRepo = new QuestionRepository();
  private membershipRepo = new MembershipRepository();

  /**
   * Ask, as a visitor or as a signed-in member.
   *
   * `asker` is whatever the route could establish. A route that knows nobody
   * passes nothing, and the row is stored with no owner — which is a real
   * answer, not a missing one.
   */
  async ask(
    input: AskQuestionInput,
    asker?: { userId: string; organizationId: string }
  ) {
    const body = input.body.trim();
    if (body.length === 0) {
      throw new Error("Please write your question");
    }
    if (body.length > QUESTION_MAX_LENGTH) {
      throw new Error(
        `A question must be ${QUESTION_MAX_LENGTH} characters or fewer`
      );
    }

    const email = input.email?.trim() || null;
    if (email && email.length > QUESTION_EMAIL_MAX) {
      throw new Error("That email address is too long");
    }
    /*
     * Shape only, and deliberately loose.
     *
     * The address is never sent to, only shown to the admin so they can reply
     * by hand — so the cost of accepting an odd one is nil, and the cost of
     * rejecting a valid unusual one is a question we never hear.
     */
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("That does not look like an email address");
    }

    const name = input.name?.trim().slice(0, QUESTION_NAME_MAX) || null;

    let membershipId: string | null = null;
    let organizationId: string | null = null;
    if (asker) {
      // Resolved rather than trusted, the same as feedback: the list shows the
      // organisation beside the words.
      const membership = await this.membershipRepo.findByUserAndOrg(
        asker.userId,
        asker.organizationId
      );
      if (membership) {
        membershipId = membership.id;
        organizationId = asker.organizationId;
      }
    }

    return this.questionRepo.create({
      body,
      email,
      name,
      membershipId,
      organizationId,
    });
  }

  /** The platform admin's list: oldest first, unanswered by default. */
  async getList(includeHandled = false, requestedPage = 0) {
    const total = await this.questionRepo.count(includeHandled);
    const lastPage = Math.max(0, Math.ceil(total / QUESTION_PAGE_SIZE) - 1);
    const page = Math.min(Math.max(0, Math.floor(requestedPage) || 0), lastPage);

    const rows = await this.questionRepo.findList(
      includeHandled,
      QUESTION_PAGE_SIZE,
      page * QUESTION_PAGE_SIZE
    );

    const askedRecently = await this.questionRepo.countSince(
      new Date(Date.now() - QUESTION_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    );

    return { rows, total, page, pageSize: QUESTION_PAGE_SIZE, askedRecently };
  }

  async setHandled(questionId: string, handled: boolean) {
    const existing = await this.questionRepo.findById(questionId);
    if (!existing) throw new Error("Question not found");
    return this.questionRepo.setHandled(questionId, handled ? new Date() : null);
  }
}
