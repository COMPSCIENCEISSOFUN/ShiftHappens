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
//
// `editable` is for the one case that needs a reader who may look but not
// change: `canAny` still answers true, or the page would refuse them entirely.
let editable = true;
vi.mock("@/components/layout/permission-provider", () => ({
  usePermissions: () => ({
    can: (permission: string) =>
      editable || !permission.startsWith("members:"),
    canAny: () => true,
    loading: false,
  }),
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
  editable = true;
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

/**
 * What the page says when an edit fails.
 *
 * Four handlers each did `const r = await res.json()` and fell back to a bare
 * "Something went wrong". That covers two completely different situations — the
 * server refused and said why, or the response was not JSON at all — and
 * reported them identically, so a refusal somebody could act on looked the same
 * as a dev server that had failed to recompile.
 */
describe("a failed edit says which fault occurred", () => {
  function apiThatFails(response: Partial<Response> & { json: () => Promise<unknown> }) {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          return Promise.resolve(response as Response);
        }
        const body = String(url).includes("/members/seniority")
          ? []
          : String(url).includes("/members")
            ? [member({ role: "manager" })]
            : [];
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
        } as Response);
      })
    );
  }

  async function openDrawerAndToggleRole() {
    render(<MembersPage />);
    await screen.findAllByText("Alex Rivera");
    await userEvent.click(screen.getAllByRole("button", { name: /edit/i })[0]);
    await userEvent.selectOptions(screen.getByLabelText("Role"), "staff");
  }

  it("shows the server's own reason when there is one", async () => {
    apiThatFails({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: "You cannot change your own role" }),
    });

    await openDrawerAndToggleRole();

    expect(
      await screen.findByText("You cannot change your own role")
    ).toBeInTheDocument();
  });

  /*
   * The case that produced an unactionable message. A 500 carrying an HTML
   * error page — a build failure, a proxy timeout — made `res.json()` throw,
   * and the catch reported it as "Something went wrong", which points nowhere.
   */
  it("says the response was unreadable rather than blaming nothing in particular", async () => {
    apiThatFails({
      ok: false,
      status: 500,
      json: () => Promise.reject(new SyntaxError("Unexpected token <")),
    });

    await openDrawerAndToggleRole();

    const message = await screen.findByText(/no readable error/i);
    expect(message.textContent).toContain("500");
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  // A refusal with a status but no `error` field still names the status, so the
  // reader has something to quote.
  it("falls back to the status code when the body says nothing", async () => {
    apiThatFails({ ok: false, status: 409, json: () => Promise.resolve({}) });

    await openDrawerAndToggleRole();

    expect(await screen.findByText(/\(409\)/)).toBeInTheDocument();
  });
});

/**
 * The Actions column, and where its job went.
 *
 * Every row carried one button, "Edit", opening the drawer the row already
 * opened on click — a whole column, on every row, duplicating the row itself.
 *
 * It was not decoration, though, and that is the part worth pinning. Its
 * comment said so: a `<tr onClick>` cannot be reached by keyboard, and making
 * the row focusable turns every cell into a tab stop. The button WAS the
 * keyboard path. Deleting the column without moving that job would have made
 * the drawer — and therefore every edit on this page — mouse-only, which no
 * screenshot would show.
 *
 * The name carries it now. It is where somebody would click anyway.
 */
describe("opening a member without an Actions column", () => {
  it("has no Actions column", async () => {
    mockApi([member()]);
    render(<MembersPage />);

    await screen.findAllByText("Alex Rivera");
    expect(
      screen.queryByRole("columnheader", { name: /actions/i })
    ).not.toBeInTheDocument();
  });

  /*
   * A button, not a row handler — which is the whole point. `getByRole` only
   * finds it if it is genuinely focusable and announced as a control, so this
   * is the keyboard path being asserted rather than described.
   */
  it("makes the member's name the control", async () => {
    mockApi([member()]);
    render(<MembersPage />);

    await screen.findAllByText("Alex Rivera");
    expect(
      screen.getByRole("button", { name: "Edit Alex Rivera" })
    ).toBeInTheDocument();
  });

  it("opens the drawer from it", async () => {
    mockApi([member()]);
    render(<MembersPage />);

    await screen.findAllByText("Alex Rivera");
    await userEvent.click(screen.getByRole("button", { name: "Edit Alex Rivera" }));

    expect(
      screen.getByRole("dialog", { name: "Edit Alex Rivera" })
    ).toBeInTheDocument();
  });

  // The actual claim: reachable without a mouse. `userEvent.tab()` walks the
  // real focus order, so this fails if the name is a <p> with a click handler.
  it("reaches it by keyboard", async () => {
    mockApi([member()]);
    render(<MembersPage />);

    await screen.findAllByText("Alex Rivera");
    const control = screen.getByRole("button", { name: "Edit Alex Rivera" });

    control.focus();
    await userEvent.keyboard("{Enter}");

    expect(
      screen.getByRole("dialog", { name: "Edit Alex Rivera" })
    ).toBeInTheDocument();
  });

  /*
   * Somebody who may READ the member list but change nothing gets plain text.
   * A control that opens a drawer of disabled fields is an invitation to a
   * dead end, and the drawer's own guards are about WHICH field, not whether
   * to be here at all.
   */
  it("leaves the name as text for a reader who cannot edit", async () => {
    editable = false;
    mockApi([member()]);
    render(<MembersPage />);

    await screen.findAllByText("Alex Rivera");
    expect(screen.queryByRole("button", { name: /Edit Alex Rivera/ })).toBeNull();
  });

  // Falls back to the email, because a member invited but not yet signed up has
  // no name — and "Edit Unnamed" beside three others says nothing.
  it("names an unnamed member by their email", async () => {
    mockApi([member({ user: { id: "u1", name: null, email: "alex@example.com" } })]);
    render(<MembersPage />);

    await screen.findAllByText("alex@example.com");
    expect(
      screen.getByRole("button", { name: "Edit alex@example.com" })
    ).toBeInTheDocument();
  });
});
