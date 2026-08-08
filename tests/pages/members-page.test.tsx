// @vitest-environment jsdom
/**
 * The members page, and the two places it forgot that managers work shifts.
 *
 * `canBeRostered` is staff AND managers — the eligibility engine, `assignStaff`
 * and `findSchedulableStaff` all admit both. This page asked `role === "staff"`
 * twice, which is the same mistake found in the member drawer and the demo seed
 * earlier the same day, in a codebase where "fixing a bug in one place does not
 * fix the class" is already the most repeated lesson.
 *
 *  - the INVITE form only asked about employment type for staff, so every
 *    manager invited through the app arrived blank — and blank reads as casual,
 *    meaning a salaried duty manager could set their own availability and take
 *    days off without asking;
 *  - the full-time and casual TILES counted only staff, so a venue with three
 *    full-time managers saw them in neither, while the pair was presented as a
 *    breakdown of the workforce.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import MembersPage from "@/app/(app)/org/[orgId]/members/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1" }),
}));

// The page renders a "you don't have access" state without these, so the mock
// grants everything — what is under test is which ROLES the page counts and
// asks about, not who may see it.
vi.mock("@/components/layout/permission-provider", () => ({
  usePermissions: () => ({ can: () => true, canAny: () => true, loading: false }),
}));

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    role: "staff",
    status: "active",
    employmentType: "casual",
    customRole: null,
    user: { id: "u1", name: "Alex Rivera", email: "alex@example.com" },
    departmentMemberships: [],
    ...overrides,
  };
}

function mockApi(members: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const body = url.includes("/members/seniority")
        ? []
        : url.includes("/members")
          ? members
          : [];
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
      } as Response);
    })
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The Employment tile, which carries the breakdown in its detail line as
 * "N full-time · M casual" and the rosterable total as its headline.
 *
 * Scoped to the tile rather than queried globally: a member list is full of
 * stray numbers and the words "Full-time" and "Casual" also appear as badges on
 * every row, so an unscoped query would pass on almost any render.
 */
/**
 * The "Type" cell of the first body row, found by the header's position rather
 * than a fixed index, so inserting a column ahead of it does not silently point
 * this at the wrong one.
 */
function typeCell() {
  const headers = [...document.querySelectorAll("thead th")];
  const index = headers.findIndex((h) => h.textContent?.trim() === "Type");
  expect(index, "no Type column in the members table").toBeGreaterThan(-1);
  const row = document.querySelector("tbody tr") as HTMLElement;
  return row.querySelectorAll("td")[index] as HTMLElement;
}

function employmentTile() {
  return screen.getByText("Employment").closest("div") as HTMLElement;
}

describe("the workforce tiles count everyone who can be rostered", () => {
  it("counts a full-time manager as full-time", async () => {
    mockApi([
      member({ id: "m1", role: "manager", employmentType: "full_time" }),
      member({
        id: "m2",
        role: "staff",
        employmentType: "full_time",
        user: { id: "u2", name: "Jamie", email: "jamie@example.com" },
      }),
    ]);
    render(<MembersPage />);

    await screen.findAllByText("Alex Rivera");
    expect(within(employmentTile()).getByText(/2 full-time/)).toBeInTheDocument();
  });

  it("counts a casual manager as casual", async () => {
    mockApi([
      member({ id: "m1", role: "manager", employmentType: "casual" }),
      member({
        id: "m2",
        role: "staff",
        employmentType: "casual",
        user: { id: "u2", name: "Jamie", email: "jamie@example.com" },
      }),
    ]);
    render(<MembersPage />);

    await screen.findAllByText("Alex Rivera");
    expect(within(employmentTile()).getByText(/2 casual/)).toBeInTheDocument();
  });

  /*
   * Admins are excluded and should stay excluded. They cannot be put on a
   * shift, so counting them in a workforce breakdown would inflate a number
   * that exists to answer "who can I roster".
   */
  it("leaves admins out of both", async () => {
    mockApi([
      member({ id: "m1", role: "company_admin", employmentType: "full_time" }),
    ]);
    render(<MembersPage />);

    await screen.findAllByText("Alex Rivera");
    expect(within(employmentTile()).getByText("0 full-time · 0 casual")).toBeInTheDocument();
  });

  /*
   * A blank employment type reads as casual everywhere else, so the tile has to
   * agree — otherwise the two numbers do not add up to the rosterable headcount
   * and nobody can tell which is wrong.
   */
  it("treats a blank employment type as casual", async () => {
    mockApi([member({ id: "m1", role: "manager", employmentType: null })]);
    render(<MembersPage />);

    await screen.findAllByText("Alex Rivera");
    expect(within(employmentTile()).getByText(/1 casual/)).toBeInTheDocument();
  });
});

describe("a manager's employment type is visible in the list", () => {
  /*
   * The table showed "—" for every manager, and the mobile card omitted the
   * badge entirely. A dash reads as "not applicable", which is true of admins
   * and false of managers — for whom the field decides whether they set their
   * own availability.
   */
  it("shows it in the table rather than a dash", async () => {
    mockApi([member({ role: "manager", employmentType: "full_time" })]);
    render(<MembersPage />);

    await screen.findAllByText("Alex Rivera");

    /*
     * The Type CELL, not the table and not the document.
     *
     * "Full-time" is also an <option> in the edit drawer's select, so an
     * unscoped query passed with the column showing a dash — the assertion
     * survived its own mutation. And a row-wide query is no good either: other
     * columns legitimately show a dash when a member has no departments.
     */
    expect(within(typeCell()).getByText("Full-time")).toBeInTheDocument();
  });

  // Admins keep the dash: they are never rostered, so the field has nothing to
  // act on and a value would state a fact nobody established.
  it("still shows a dash for an admin", async () => {
    mockApi([member({ role: "company_admin", employmentType: null })]);
    render(<MembersPage />);

    await screen.findAllByText("Alex Rivera");
    /*
     * Scoped to the table. "Casual" is also an <option> in the edit drawer's
     * employment select, which is always in the DOM — an unscoped negative
     * would fail on a correct render.
     */
    const table = document.querySelector("table") as HTMLElement;
    expect(within(table).getAllByText("—").length).toBeGreaterThan(0);
    expect(within(table).queryByText("Casual")).not.toBeInTheDocument();
  });
});

describe("the invite form asks everyone who can be rostered", () => {
  async function openInvite() {
    mockApi([member()]);
    render(<MembersPage />);
    await screen.findAllByText("Alex Rivera");
    await userEvent.click(screen.getByRole("button", { name: /invite/i }));
  }

  it("asks a staff invitee for an employment type", async () => {
    await openInvite();
    expect(screen.getByLabelText("Employment Type")).toBeInTheDocument();
  });

  /*
   * The bug. Choosing Manager hid the field, so the invitation carried no
   * employment type and the new manager arrived defaulting to casual — free to
   * set their own availability and take days off without asking.
   */
  it("still asks when the invitee is a manager", async () => {
    await openInvite();

    await userEvent.selectOptions(screen.getByLabelText("Role"), "manager");

    expect(screen.getByLabelText("Employment Type")).toBeInTheDocument();
  });

  it("sends the chosen type when inviting a manager", async () => {
    await openInvite();

    await userEvent.selectOptions(screen.getByLabelText("Role"), "manager");
    await userEvent.selectOptions(
      screen.getByLabelText("Employment Type"),
      "full_time"
    );
    await userEvent.type(
      screen.getByLabelText(/email/i),
      "newmanager@example.com"
    );
    await userEvent.click(screen.getByRole("button", { name: /send invit/i }));

    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      ([url, init]) =>
        String(url).includes("/invitations") &&
        (init as RequestInit | undefined)?.method === "POST"
    );
    expect(call, "no invitation POST was made").toBeTruthy();
    expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({
      role: "manager",
      employmentType: "full_time",
    });
  });
});
