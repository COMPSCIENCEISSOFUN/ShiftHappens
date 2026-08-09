// @vitest-environment jsdom
/**
 * Choosing which certificates a shift requires.
 *
 * This was a text box — `placeholder="e.g. Food Safety, RSA"` — and the
 * member's own screen was a different text box placeholdered "e.g. Food Safety
 * Level 2". Eligibility compares the two by lower-cased string equality, so a
 * member following one hint and a manager following the other produced a
 * non-match: silently ineligible for a shift they were qualified for, and told
 * they were "Missing required certification(s): Food Safety" while holding one.
 *
 * The part worth testing is not that chips toggle. It is the handling of a
 * requirement the list does NOT contain, because that is where this change
 * could destroy data: a manager opening a shift to move its start time, saving,
 * and losing a food-safety requirement with nothing said.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CertificationPicker } from "@/components/certifications/certification-picker";

const OPTIONS = [
  { id: "t1", name: "Food Safety" },
  { id: "t2", name: "RSA" },
  { id: "t3", name: "First Aid" },
];

function renderPicker(
  props: Partial<Parameters<typeof CertificationPicker>[0]> = {}
) {
  const onToggle = vi.fn();
  render(
    <CertificationPicker
      options={OPTIONS}
      selected={[]}
      onToggle={onToggle}
      orgId="org1"
      canManageList
      {...props}
    />
  );
  return onToggle;
}

describe("picking from the list", () => {
  it("offers every recognised name", () => {
    renderPicker();

    for (const option of OPTIONS) {
      expect(screen.getByRole("button", { name: option.name })).toBeInTheDocument();
    }
  });

  it("passes the name back, not an id", () => {
    const onToggle = renderPicker();

    void userEvent.click(screen.getByRole("button", { name: "RSA" }));

    return vi.waitFor(() => expect(onToggle).toHaveBeenCalledWith("RSA"));
  });

  it("marks the ones already required", () => {
    renderPicker({ selected: ["RSA"] });

    expect(screen.getByRole("button", { name: "RSA" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "First Aid" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  /*
   * A task written before the list existed may hold a different spelling of a
   * name that is now on it. Eligibility matches those case-insensitively, so
   * the chip has to as well — otherwise the same certificate would appear
   * twice, once as a recognised option and once as an unrecognised extra.
   */
  it("recognises a requirement that differs only in case", () => {
    renderPicker({ selected: ["food safety"] });

    expect(screen.getByRole("button", { name: "Food Safety" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.queryByText(/not on the organisation's list/i)).toBeNull();
  });

  it("counts what is selected", () => {
    renderPicker({ selected: ["RSA", "First Aid"] });
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });
});

/**
 * Requirements the list does not contain.
 *
 * The dangerous case, and the reason this component exists rather than a plain
 * `<select multiple>`. Dropping them silently would mean a shift quietly
 * stopping checking for a certificate — the exact failure the whole change was
 * made to prevent, arriving through the fix for it.
 */
describe("a requirement that is not on the list", () => {
  it("is still shown", () => {
    renderPicker({ selected: ["Forklift"] });

    expect(screen.getByRole("button", { name: "Forklift" })).toBeInTheDocument();
  });

  it("says so, naming it", () => {
    renderPicker({ selected: ["Forklift"] });

    expect(screen.getByText(/"Forklift" is not on the organisation's list/)).toBeInTheDocument();
  });

  // It can be removed — removal is not what the list is guarding. But the
  // warning says it cannot be added back, because that is true and is the part
  // somebody would otherwise discover afterwards.
  it("can be removed", () => {
    const onToggle = renderPicker({ selected: ["Forklift"] });

    void userEvent.click(screen.getByRole("button", { name: "Forklift" }));

    return vi.waitFor(() => expect(onToggle).toHaveBeenCalledWith("Forklift"));
  });

  it("warns that removing it is one-way", () => {
    renderPicker({ selected: ["Forklift"] });

    expect(screen.getByText(/cannot be added back/i)).toBeInTheDocument();
  });

  it("counts them together rather than naming each", () => {
    renderPicker({ selected: ["Forklift", "Scaffolding"] });

    expect(
      screen.getByText(/2 of these are not on the organisation's list/)
    ).toBeInTheDocument();
  });

  it("says nothing when every requirement is recognised", () => {
    renderPicker({ selected: ["RSA"] });

    expect(screen.queryByText(/not on the organisation's list/i)).toBeNull();
  });
});

/**
 * An empty list.
 *
 * A new organisation has one, and a picker with nothing in it and no
 * explanation reads as a broken control rather than as a setting nobody has
 * filled in yet.
 */
describe("before anything is recognised", () => {
  it("explains rather than rendering an empty box", () => {
    renderPicker({ options: [] });

    expect(
      screen.getByText(/no recognised certificates yet/i)
    ).toBeInTheDocument();
  });

  it("points somebody who can fix it at the page where they would", () => {
    renderPicker({ options: [] });

    expect(screen.getByRole("link", { name: /Certifications page/i })).toHaveAttribute(
      "href",
      "/org/org1/certifications"
    );
  });

  // A manager without `certifications:review` cannot add one, so a link would
  // send them somewhere that refuses them. They are told who can instead.
  it("tells somebody who cannot who to ask", () => {
    renderPicker({ options: [], canManageList: false });

    expect(screen.getByText(/Ask a company admin/i)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  /*
   * An empty LIST with an existing requirement is not an empty picker. This is
   * the state every organisation is in for the moment between deploying the
   * change and running the backfill, and showing the explanation instead of the
   * requirement would hide the thing that is about to be lost.
   */
  it("still shows an unrecognised requirement when the list is empty", () => {
    renderPicker({ options: [], selected: ["Food Safety"] });

    expect(screen.getByRole("button", { name: "Food Safety" })).toBeInTheDocument();
    expect(screen.queryByText(/no recognised certificates yet/i)).toBeNull();
  });
});
