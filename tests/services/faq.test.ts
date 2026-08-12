/**
 * The landing page FAQ.
 *
 * The rule worth holding is that writing and publishing are separate acts: an
 * entry reaches the public site because somebody decided it should, not because
 * they saved it.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  FaqService,
  FAQ_ANSWER_MAX,
  FAQ_POSITION_MAX,
  FAQ_QUESTION_MAX,
} from "@/services/faq.service";

import { cleanDatabase } from "../helpers/cleanup";

const faq = new FaqService();

beforeEach(async () => {
  await cleanDatabase();
});

describe("writing an entry", () => {
  it("creates it unpublished", async () => {
    const entry = await faq.create({
      question: "Can I change plans later?",
      answer: "At any time.",
    });

    expect(entry.published).toBe(false);
    expect(await faq.getPublished()).toEqual([]);
  });

  /* Appended, so a new draft does not arrive at the top of a public list. */
  it("puts each new entry after the last", async () => {
    const first = await faq.create({ question: "First?", answer: "Yes." });
    const second = await faq.create({ question: "Second?", answer: "Also yes." });

    expect(second.position).toBeGreaterThan(first.position);
  });

  it("trims before storing", async () => {
    const entry = await faq.create({
      question: "  Spaced out?  ",
      answer: "  Trimmed.  ",
    });

    expect(entry.question).toBe("Spaced out?");
    expect(entry.answer).toBe("Trimmed.");
  });

  it.each([
    ["a question of only whitespace", { question: "   ", answer: "Fine." }, /question is required/i],
    ["an answer of only whitespace", { question: "Fine?", answer: "   " }, /answer is required/i],
  ])("refuses %s", async (_label, input, expected) => {
    await expect(faq.create(input)).rejects.toThrow(expected);
  });

  it("refuses a question past the cap", async () => {
    await expect(
      faq.create({ question: "x".repeat(FAQ_QUESTION_MAX + 1), answer: "Fine." })
    ).rejects.toThrow(/characters or fewer/i);
  });

  it("refuses an answer past the cap", async () => {
    await expect(
      faq.create({ question: "Fine?", answer: "x".repeat(FAQ_ANSWER_MAX + 1) })
    ).rejects.toThrow(/characters or fewer/i);
  });
});

describe("what the landing page reads", () => {
  it("returns published entries in position order", async () => {
    const a = await faq.create({ question: "A?", answer: "." });
    const b = await faq.create({ question: "B?", answer: "." });
    await faq.update(a.id, { published: true, position: 5 });
    await faq.update(b.id, { published: true, position: 1 });

    const published = await faq.getPublished();

    expect(published.map((entry) => entry.question)).toEqual(["B?", "A?"]);
  });

  /*
   * Two entries at the same position is what "I have not ordered these yet"
   * looks like, and the order must still be the same on every render.
   */
  it("orders equal positions stably", async () => {
    for (const question of ["One?", "Two?", "Three?"]) {
      const entry = await faq.create({ question, answer: "." });
      await faq.update(entry.id, { published: true, position: 0 });
    }

    const first = await faq.getPublished();
    const second = await faq.getPublished();

    expect(first.map((e) => e.id)).toEqual(second.map((e) => e.id));
  });

  it("leaves drafts out", async () => {
    const shown = await faq.create({ question: "Shown?", answer: "." });
    await faq.create({ question: "Hidden?", answer: "." });
    await faq.update(shown.id, { published: true });

    const published = await faq.getPublished();

    expect(published.map((entry) => entry.question)).toEqual(["Shown?"]);
  });

  it("returns nothing when nothing is published", async () => {
    await faq.create({ question: "Draft?", answer: "." });

    expect(await faq.getPublished()).toEqual([]);
  });
});

describe("editing an entry", () => {
  it("changes one field without clearing the other", async () => {
    const entry = await faq.create({ question: "Before?", answer: "Kept." });

    const updated = await faq.update(entry.id, { question: "After?" });

    expect(updated.question).toBe("After?");
    expect(updated.answer).toBe("Kept.");
  });

  it("unpublishes without deleting", async () => {
    const entry = await faq.create({ question: "Live?", answer: "." });
    await faq.update(entry.id, { published: true });

    await faq.update(entry.id, { published: false });

    expect(await faq.getPublished()).toEqual([]);
    expect(await prisma.faqEntry.count()).toBe(1);
  });

  it.each([[-1], [1.5]])("refuses position %s", async (position) => {
    const entry = await faq.create({ question: "Q?", answer: "." });

    await expect(faq.update(entry.id, { position })).rejects.toThrow(
      /whole number/i
    );
  });

  /*
   * The column is a 32-bit integer and `create` appends at highest + 1, so an
   * accepted 2147483647 would make the NEXT create overflow — and every create
   * after it, permanently, with a 500 and nothing on screen explaining why.
   */
  it("refuses a position that would overflow the column", async () => {
    const entry = await faq.create({ question: "Q?", answer: "." });

    await expect(
      faq.update(entry.id, { position: 2147483647 })
    ).rejects.toThrow(/between 0 and/i);
  });

  it("still creates the next entry after one sits at the maximum", async () => {
    const first = await faq.create({ question: "Last?", answer: "." });
    await faq.update(first.id, { position: FAQ_POSITION_MAX });

    const second = await faq.create({ question: "After?", answer: "." });

    expect(second.position).toBe(FAQ_POSITION_MAX);
  });

  it("refuses an edit that would empty a field", async () => {
    const entry = await faq.create({ question: "Q?", answer: "A." });

    await expect(faq.update(entry.id, { answer: "   " })).rejects.toThrow(
      /answer is required/i
    );
  });

  it("refuses an id that does not exist", async () => {
    await expect(
      faq.update("no-such-id", { published: true })
    ).rejects.toThrow(/not found/i);
  });
});

describe("deleting an entry", () => {
  it("removes it", async () => {
    const entry = await faq.create({ question: "Q?", answer: "." });

    await faq.delete(entry.id);

    expect(await prisma.faqEntry.count()).toBe(0);
  });

  it("refuses an id that does not exist", async () => {
    await expect(faq.delete("no-such-id")).rejects.toThrow(/not found/i);
  });
});
