// @vitest-environment jsdom
/**
 * The order of the fields in the New Task form.
 *
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import TasksPage from "@/app/(app)/org/[orgId]/tasks/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1" }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/layout/permission-provider", () => ({
  usePermissions: () => ({ can: () => true, canAny: () => true, loading: false }),
}));

const CERT_TYPES = [
  { id: "t1", name: "Food Safety Level 2" },
  { id: "t2", name: "RSA Certification" },
];

function mockApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const path = String(url);
      const body = path.includes("/certification-types")
        ? CERT_TYPES
        : path.includes("/settings")
          ? { operatingHoursStart: 8, operatingHoursEnd: 22 }
          : [];
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      } as Response);
    })
  );
}

/** Opens the create form and returns every labelled control in DOM order. */
async function openForm() {
  render(<TasksPage />);
  await userEvent.click(await screen.findByRole("button", { name: /create task/i }));
  return screen.getByText("Title").closest("form") as HTMLElement;
}

/**
 * The position of a labelled field among the other LABELLED fields.
 *
 * Useful for grouping, and NOT sufficient for adjacency — see `wrapperFor`.
 * Counting only `<label>` elements skips anything headed some other way, so a
 * block inserted between two fields would leave these indices untouched.
 */
function positionOf(form: HTMLElement, label: string): number {
  const nodes = Array.from(form.querySelectorAll("label"));
  const index = nodes.findIndex((n) => n.textContent?.trim() === label);
  if (index === -1) throw new Error(`No field labelled "${label}"`);
  return index;
}

/**
 * The grid cell a field occupies — the element the layout actually places.
 *
 * Adjacency has to be asserted on these rather than on label indices. The first
 * version of the test below compared positions in the list of `<label>`s and
 * passed with the composition editor sitting between Start and End, because
 * that editor heads itself with a `<p>`: a test named for the bug, unable to
 * detect it. Comparing siblings asks the question directly — is there anything
 * between these two cells, whatever it calls itself.
 */
function wrapperFor(form: HTMLElement, htmlFor: string): Element {
  const label = form.querySelector(`label[for="${htmlFor}"]`);
  if (!label?.parentElement) throw new Error(`No field for "${htmlFor}"`);
  return label.parentElement;
}

/**
 * Where something sits in the form overall, labelled or not.
 *
 * The composition editor heads itself with a `<p>` rather than a `<label>` —
 * it is a group of controls rather than one field — so it cannot be counted
 * alongside the others. Document order still answers "does this come after
 * that", which is all the tall-field assertions need.
 */
function orderOf(form: HTMLElement, text: string): number {
  const all = Array.from(form.querySelectorAll("*"));
  const index = all.findIndex((el) => el.textContent?.trim().startsWith(text));
  if (index === -1) throw new Error(`Nothing in the form reads "${text}"`);
  return index;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the New Task form reads in a sensible order", () => {
  it("puts End time straight after Start time, with nothing between", async () => {
    mockApi();
    const form = await openForm();

    expect(wrapperFor(form, "scheduledStart").nextElementSibling).toBe(
      wrapperFor(form, "scheduledEnd")
    );
  });

  /*
   * The two tall fields come AFTER the times rather than between them. This is
   * the assertion that would have failed before: the composition editor sat
   * between Start and End.
   */
  it("keeps the tall fields out from between them", async () => {
    mockApi();
    const form = await openForm();

    const end = orderOf(form, "End time");
    expect(orderOf(form, "Required certifications")).toBeGreaterThan(end);
    expect(orderOf(form, "Team composition")).toBeGreaterThan(end);
  });

  // The three short controls are consecutive, so they can share one row rather
  // than one of them being stranded beside something five rows tall.
  it("groups the three short controls together", async () => {
    mockApi();
    const form = await openForm();

    const department = positionOf(form, "Department");
    expect(positionOf(form, "Priority")).toBe(department + 1);
    expect(positionOf(form, "Required headcount")).toBe(department + 2);
  });

  it("still asks for a title first", async () => {
    mockApi();
    const form = await openForm();

    expect(positionOf(form, "Title")).toBe(0);
    expect(positionOf(form, "Description")).toBe(1);
  });

  // Recurrence last: it is the only field about shifts OTHER than this one, and
  // it is the one most often left alone.
  it("leaves Repeats until the end", async () => {
    mockApi();
    const form = await openForm();

    expect(orderOf(form, "Repeats")).toBeGreaterThan(
      orderOf(form, "Team composition")
    );
  });
});
