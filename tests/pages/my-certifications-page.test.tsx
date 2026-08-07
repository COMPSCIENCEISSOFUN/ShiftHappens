// @vitest-environment jsdom
/**
 * Filtering the member's own certificates.
 *
 * Client-side, deliberately. This endpoint returns one member's certificates —
 * a handful of rows, already in memory — so a round trip per keystroke would
 * buy nothing and cost a spinner. My History filters server-side because it is
 * PAGED and its totals describe the whole range; neither is true here, and
 * building the same machinery for both would be over-engineering one of them.
 *
 * The page had no rendered test before this. What is pinned is the filtering,
 * the two empty states, and the rule that a control which cannot do anything
 * should not be on screen inviting a click.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import MyCertificationsPage from "@/app/(app)/org/[orgId]/my-certifications/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1" }),
}));

const YEAR = 365 * 24 * 3_600_000;

function cert(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    name: "First Aid",
    issuedDate: new Date(Date.now() - YEAR).toISOString(),
    expiryDate: new Date(Date.now() + YEAR).toISOString(),
    documentUrl: null,
    status: "verified",
    rejectionReason: null,
    rejectionNotes: null,
    verifiedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    verifiedBy: { id: "u1", name: "Sarah" },
    ...overrides,
  };
}

function mockApi(rows: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(rows) } as Response)
    )
  );
}

/** Four, since the controls only appear once there is enough to sift. */
function many() {
  return [
    cert({ id: "c1", name: "First Aid", status: "verified" }),
    cert({ id: "c2", name: "Food Safety", status: "pending", verifiedAt: null, verifiedBy: null }),
    cert({ id: "c3", name: "Fire Warden", status: "rejected", verifiedAt: null, verifiedBy: null, rejectionReason: "illegible_document" }),
    cert({ id: "c4", name: "Forklift Licence", status: "verified" }),
  ];
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the controls appear when they are useful", () => {
  /*
   * Two certificates do not need a filter. A control that can only ever do
   * nothing is worse than no control, because it invites a click that changes
   * nothing and reads as broken.
   */
  it("stays hidden for a short list", async () => {
    mockApi([cert()]);
    render(<MyCertificationsPage />);

    await screen.findByText("First Aid");
    expect(screen.queryByLabelText("Status")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Search certifications")).not.toBeInTheDocument();
  });

  it("appears once there is enough to sift", async () => {
    mockApi(many());
    render(<MyCertificationsPage />);

    expect(await screen.findByLabelText("Status")).toBeInTheDocument();
    expect(screen.getByLabelText("Search certifications")).toBeInTheDocument();
  });
});

describe("narrowing the list", () => {
  it("keeps only the chosen status", async () => {
    mockApi(many());
    render(<MyCertificationsPage />);
    await screen.findByText("First Aid");

    await userEvent.selectOptions(screen.getByLabelText("Status"), "pending");

    expect(screen.getByText("Food Safety")).toBeInTheDocument();
    expect(screen.queryByText("First Aid")).not.toBeInTheDocument();
  });

  it("finds a certificate by part of its name", async () => {
    mockApi(many());
    render(<MyCertificationsPage />);
    await screen.findByText("First Aid");

    await userEvent.type(screen.getByLabelText("Search certifications"), "fork");

    expect(screen.getByText("Forklift Licence")).toBeInTheDocument();
    expect(screen.queryByText("First Aid")).not.toBeInTheDocument();
  });

  /*
   * Names are typed by whoever uploaded the certificate, so matching the
   * capitalisation they happened to use would be a search that only works if
   * you already know the answer.
   */
  it("ignores case", async () => {
    mockApi(many());
    render(<MyCertificationsPage />);
    await screen.findByText("First Aid");

    await userEvent.type(screen.getByLabelText("Search certifications"), "FIRST");

    expect(screen.getByText("First Aid")).toBeInTheDocument();
  });

  it("combines status and search rather than replacing one with the other", async () => {
    mockApi(many());
    render(<MyCertificationsPage />);
    await screen.findByText("First Aid");

    await userEvent.selectOptions(screen.getByLabelText("Status"), "verified");
    await userEvent.type(screen.getByLabelText("Search certifications"), "first");

    expect(screen.getByText("First Aid")).toBeInTheDocument();
    // Verified but not matching the text.
    expect(screen.queryByText("Forklift Licence")).not.toBeInTheDocument();
    // Matching neither.
    expect(screen.queryByText("Food Safety")).not.toBeInTheDocument();
  });

  it("offers a way back only once something is filtered", async () => {
    mockApi(many());
    render(<MyCertificationsPage />);
    await screen.findByText("First Aid");

    expect(screen.queryByRole("button", { name: /^clear$/i })).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Status"), "pending");

    expect(screen.getByRole("button", { name: /^clear$/i })).toBeInTheDocument();
  });

  it("restores the whole list when cleared", async () => {
    mockApi(many());
    render(<MyCertificationsPage />);
    await screen.findByText("First Aid");

    await userEvent.selectOptions(screen.getByLabelText("Status"), "pending");
    await userEvent.click(screen.getByRole("button", { name: /^clear$/i }));

    expect(screen.getByText("First Aid")).toBeInTheDocument();
    expect(screen.getByText("Forklift Licence")).toBeInTheDocument();
  });
});

describe("the two empty states", () => {
  /*
   * A member who has uploaded four certificates and filtered them all away has
   * not got "no certifications yet" — telling them so reads as the system
   * having lost them, and the offer to add their first one is nonsense.
   */
  it("blames the filters when the member has certificates", async () => {
    mockApi(many());
    render(<MyCertificationsPage />);
    await screen.findByText("First Aid");

    await userEvent.type(screen.getByLabelText("Search certifications"), "zzzz");

    expect(screen.getByText(/Nothing matches/i)).toBeInTheDocument();
    expect(screen.queryByText(/No certifications yet/i)).not.toBeInTheDocument();
  });

  it("does not offer to add a first one when they already have four", async () => {
    mockApi(many());
    render(<MyCertificationsPage />);
    await screen.findByText("First Aid");

    await userEvent.type(screen.getByLabelText("Search certifications"), "zzzz");

    expect(
      screen.queryByRole("button", { name: /add your first certification/i })
    ).not.toBeInTheDocument();
  });

  it("invites a genuinely new member to add one", async () => {
    mockApi([]);
    render(<MyCertificationsPage />);

    expect(await screen.findByText(/No certifications yet/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /add your first certification/i })
    ).toBeInTheDocument();
  });
});
