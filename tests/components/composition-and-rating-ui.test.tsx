// @vitest-environment jsdom
/**
 * The two new controls, tested for the things that make them usable rather
 * than merely present: that a rating is announced as a value instead of five
 * unlabelled pictures, and that a malformed composition rule is refused in the
 * form with the same words the API would use.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StarRatingDisplay, StarRatingInput } from "@/components/ui/star-rating";
import { CompositionRulesEditor } from "@/components/tasks/composition-rules-editor";
import { MAX_COMPOSITION_RULES, type CompositionRule } from "@/lib/composition-rules";

const AT_MOST_ONE_JUNIOR: CompositionRule = {
  kind: "seniority",
  value: "junior",
  comparator: "at_most",
  count: 1,
};

describe("StarRatingDisplay", () => {
  // Stars are a picture of a number. Without the text, a screen reader reads
  // five identical icons and the value is simply absent.
  it("announces the value as text, not as five icons", () => {
    render(<StarRatingDisplay value={3} />);
    expect(screen.getByText(/3 out of 5/)).toBeInTheDocument();
  });

  // Twice on purpose — once announced with the number, once as the visible
  // label — because colour and fill are not signals everyone receives.
  it("names the score as well as counting it", () => {
    render(<StarRatingDisplay value={5} />);
    expect(screen.getAllByText(/Great/)).toHaveLength(2);
  });

  it("can hide the visible label without hiding it from assistive tech", () => {
    render(<StarRatingDisplay value={2} showLabel={false} />);
    expect(screen.getByText(/2 out of 5 — Poor/)).toBeInTheDocument();
  });
});

describe("StarRatingInput", () => {
  it("exposes five radios in a labelled group", () => {
    render(<StarRatingInput value={null} onChange={() => {}} />);

    const group = screen.getByRole("radiogroup", { name: "Rate this shift" });
    expect(within(group).getAllByRole("radio")).toHaveLength(5);
  });

  it("marks the current value as checked", () => {
    render(<StarRatingInput value={4} onChange={() => {}} />);

    expect(screen.getByRole("radio", { name: /^4 out of 5/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^3 out of 5/ })).not.toBeChecked();
  });

  it("reports the chosen score", async () => {
    const onChange = vi.fn();
    render(<StarRatingInput value={null} onChange={onChange} />);

    await userEvent.click(screen.getByRole("radio", { name: /^2 out of 5/ }));
    expect(onChange).toHaveBeenCalledWith(2);
  });

  // Real buttons, not icons with click handlers — so the control works without
  // a mouse.
  it("is operable from the keyboard", async () => {
    const onChange = vi.fn();
    render(<StarRatingInput value={null} onChange={onChange} />);

    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it("does not fire while disabled", async () => {
    const onChange = vi.fn();
    render(<StarRatingInput value={null} onChange={onChange} disabled />);

    await userEvent.click(screen.getByRole("radio", { name: /^5 out of 5/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("CompositionRulesEditor", () => {
  function setup(rules: CompositionRule[] = []) {
    const onChange = vi.fn();
    render(<CompositionRulesEditor rules={rules} onChange={onChange} />);
    return onChange;
  }

  it("adds the rule the controls describe", async () => {
    const onChange = setup();
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onChange).toHaveBeenCalledWith([AT_MOST_ONE_JUNIOR]);
  });

  // The whole reason for a builder rather than a text field: "At most 1
  // Junior" is ambiguous on screen in a way it is not in code.
  it("spells out which direction a seniority rule reads", () => {
    setup([AT_MOST_ONE_JUNIOR]);
    expect(screen.getByText("At most 1 assignee at Junior or below")).toBeInTheDocument();
  });

  it("removes a rule", async () => {
    const onChange = setup([AT_MOST_ONE_JUNIOR]);
    await userEvent.click(
      screen.getByRole("button", { name: /Remove rule: At most 1 assignee/ })
    );
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("refuses an at_least rule with a count of zero", async () => {
    const onChange = setup();

    await userEvent.selectOptions(screen.getByLabelText("Comparator"), "at_least");
    await userEvent.clear(screen.getByLabelText("How many assignees"));
    await userEvent.type(screen.getByLabelText("How many assignees"), "0");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/count of 1 or more/);
  });

  it("refuses a certification rule with no name", async () => {
    const onChange = setup();

    await userEvent.selectOptions(screen.getByLabelText("Rule type"), "certification");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  // Silently ignoring a duplicate leaves the author staring at an unchanged
  // list wondering whether the button worked.
  it("says so rather than silently ignoring a duplicate", async () => {
    const onChange = setup([AT_MOST_ONE_JUNIOR]);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/already on this shift/);
  });

  it("swaps the value control when the rule type changes", async () => {
    setup();

    expect(screen.getByLabelText("Seniority level")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Rule type"), "certification");

    expect(screen.queryByLabelText("Seniority level")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Certification name")).toBeInTheDocument();
  });

  it("stops offering the form once the rule limit is reached", () => {
    setup(Array.from({ length: MAX_COMPOSITION_RULES }, () => AT_MOST_ONE_JUNIOR));

    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${MAX_COMPOSITION_RULES} rules is the limit`))).toBeInTheDocument();
  });
});
