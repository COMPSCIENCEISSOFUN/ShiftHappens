/**
 * Landing page FAQ (Control layer).
 *
 * Platform-level: one marketing site, one editor. Nothing here is org-scoped,
 * and nothing here is audited, for the reason set out in `feedback.service` —
 * the audit log belongs to tenants and this content belongs to none of them.
 *
 * Publishing is a separate act from writing. An entry is created unpublished so
 * a half-finished answer cannot reach the public page by being saved.
 */
import { FaqRepository, type FaqEntryData } from "@/repositories/faq.repository";

export const FAQ_QUESTION_MAX = 200;
export const FAQ_ANSWER_MAX = 2000;
/**
 * The largest position an entry may hold.
 *
 * `position` is a Postgres INTEGER, and `create` appends at
 * `highestPosition() + 1`. Left unbounded, one edit setting 2147483647 makes
 * the NEXT create overflow the column — so every subsequent entry fails with a
 * 500 until somebody finds and lowers that row. A list a person orders by hand
 * has no business near either limit.
 */
export const FAQ_POSITION_MAX = 9999;

export class FaqService {
  private faqRepo = new FaqRepository();

  /** What the landing page renders. Published only, in editorial order. */
  async getPublished() {
    return this.faqRepo.findPublished();
  }

  /** Everything, drafts included. */
  async getAll() {
    return this.faqRepo.findAll();
  }

  async create(input: { question: string; answer: string }) {
    const data = this.validated(input);
    // Appended, not prepended: a new entry is the least considered one, and
    // arriving at the top of a public list is a decision the author has not
    // made yet.
    const position = Math.min(
      (await this.faqRepo.highestPosition()) + 1,
      FAQ_POSITION_MAX
    );
    return this.faqRepo.create({ ...data, position, published: false });
  }

  async update(
    id: string,
    input: Partial<{
      question: string;
      answer: string;
      position: number;
      published: boolean;
    }>
  ) {
    const existing = await this.faqRepo.findById(id);
    if (!existing) throw new Error("FAQ entry not found");

    const data: Partial<FaqEntryData> = {};

    if (input.question !== undefined || input.answer !== undefined) {
      const merged = this.validated({
        question: input.question ?? existing.question,
        answer: input.answer ?? existing.answer,
      });
      if (input.question !== undefined) data.question = merged.question;
      if (input.answer !== undefined) data.answer = merged.answer;
    }

    if (input.position !== undefined) {
      if (
        !Number.isInteger(input.position) ||
        input.position < 0 ||
        input.position > FAQ_POSITION_MAX
      ) {
        throw new Error(
          `Position must be a whole number between 0 and ${FAQ_POSITION_MAX}`
        );
      }
      data.position = input.position;
    }

    if (input.published !== undefined) data.published = input.published;

    return this.faqRepo.update(id, data);
  }

  async delete(id: string) {
    const existing = await this.faqRepo.findById(id);
    if (!existing) throw new Error("FAQ entry not found");
    return this.faqRepo.delete(id);
  }

  /**
   * Both fields, together.
   *
   * A question with no answer is not a draft, it is a page that asks the
   * visitor something and then stops — so emptiness is refused at write time
   * rather than hidden behind the published flag.
   */
  private validated(input: { question: string; answer: string }) {
    const question = input.question.trim();
    const answer = input.answer.trim();

    if (!question) throw new Error("A question is required");
    if (!answer) throw new Error("An answer is required");
    if (question.length > FAQ_QUESTION_MAX) {
      throw new Error(`Question must be ${FAQ_QUESTION_MAX} characters or fewer`);
    }
    if (answer.length > FAQ_ANSWER_MAX) {
      throw new Error(`Answer must be ${FAQ_ANSWER_MAX} characters or fewer`);
    }

    return { question, answer };
  }
}
