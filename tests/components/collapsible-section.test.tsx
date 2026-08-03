// @vitest-environment jsdom
/**
 * CollapsibleSection.
 *
 * Two things here are easy to get wrong in ways that look fine on a first
 * click: the remembered state, and whether collapsing throws away the
 * children's data.
 *
 * The memory is the one worth guarding. A collapse that forgets is worse than
 * no collapse — the user folds the same panel away every morning until they
 * give up on the feature.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CollapsibleSection } from "@/components/ui/collapsible-section";

beforeEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

function panel() {
  return document.getElementById("section-test");
}

describe("toggling", () => {
  it("starts open by default", () => {
    render(
      <CollapsibleSection title="Needs your action" storageKey="test">
        <p>Two shifts unfilled</p>
      </CollapsibleSection>
    );
    expect(panel()).not.toHaveAttribute("hidden");
  });

  it("honours defaultOpen={false}", () => {
    render(
      <CollapsibleSection title="Smart engine" storageKey="test" defaultOpen={false}>
        <p>charts</p>
      </CollapsibleSection>
    );
    expect(panel()).toHaveAttribute("hidden");
  });

  it("collapses and expands on click", async () => {
    const user = userEvent.setup();
    render(
      <CollapsibleSection title="Needs your action" storageKey="test">
        <p>Two shifts unfilled</p>
      </CollapsibleSection>
    );

    const toggle = screen.getByRole("button", { name: /Needs your action/ });
    await user.click(toggle);
    expect(panel()).toHaveAttribute("hidden");

    await user.click(toggle);
    expect(panel()).not.toHaveAttribute("hidden");
  });

  it("tells assistive tech whether it is open", async () => {
    const user = userEvent.setup();
    render(
      <CollapsibleSection title="Needs your action" storageKey="test">
        <p>content</p>
      </CollapsibleSection>
    );

    const toggle = screen.getByRole("button", { name: /Needs your action/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

describe("remembering the choice", () => {
  it("records the collapse", async () => {
    const user = userEvent.setup();
    render(
      <CollapsibleSection title="Needs your action" storageKey="test">
        <p>content</p>
      </CollapsibleSection>
    );

    await user.click(screen.getByRole("button", { name: /Needs your action/ }));
    expect(window.sessionStorage.getItem("section:test")).toBe("closed");
  });

  it("restores a collapsed section on the next render", () => {
    window.sessionStorage.setItem("section:test", "closed");
    render(
      <CollapsibleSection title="Needs your action" storageKey="test">
        <p>content</p>
      </CollapsibleSection>
    );
    expect(panel()).toHaveAttribute("hidden");
  });

  it("restores an expanded section that defaults closed", () => {
    // The other direction matters just as much: someone who opened the engine
    // panel should not have to open it again on every visit.
    window.sessionStorage.setItem("section:test", "open");
    render(
      <CollapsibleSection title="Smart engine" storageKey="test" defaultOpen={false}>
        <p>content</p>
      </CollapsibleSection>
    );
    expect(panel()).not.toHaveAttribute("hidden");
  });

  it("does not undo a click made after restoring", async () => {
    // The restore effect must not fight the user. If it re-ran on every state
    // change, clicking would flip the section back immediately.
    const user = userEvent.setup();
    window.sessionStorage.setItem("section:test", "closed");
    render(
      <CollapsibleSection title="Needs your action" storageKey="test">
        <p>content</p>
      </CollapsibleSection>
    );

    await user.click(screen.getByRole("button", { name: /Needs your action/ }));
    expect(panel()).not.toHaveAttribute("hidden");
  });

  it("keeps sections independent", async () => {
    const user = userEvent.setup();
    render(
      <>
        <CollapsibleSection title="First" storageKey="one">
          <p>a</p>
        </CollapsibleSection>
        <CollapsibleSection title="Second" storageKey="two">
          <p>b</p>
        </CollapsibleSection>
      </>
    );

    await user.click(screen.getByRole("button", { name: /First/ }));

    expect(document.getElementById("section-one")).toHaveAttribute("hidden");
    expect(document.getElementById("section-two")).not.toHaveAttribute("hidden");
  });

  it("still works when storage throws", () => {
    // Private browsing and some managed-device policies throw on access rather
    // than returning null. Losing the memory is fine; refusing to render is not.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    render(
      <CollapsibleSection title="Needs your action" storageKey="test">
        <p>content</p>
      </CollapsibleSection>
    );
    expect(panel()).not.toHaveAttribute("hidden");
  });
});

describe("what stays visible when collapsed", () => {
  it("keeps the count in the header, so a folded section still warns you", async () => {
    // The whole safety argument for collapsing "Needs your action" is that the
    // number survives the fold. Without it, hiding the section hides the alert.
    const user = userEvent.setup();
    render(
      <CollapsibleSection title="Needs your action" storageKey="test" count={3}>
        <p>content</p>
      </CollapsibleSection>
    );

    await user.click(screen.getByRole("button", { name: /Needs your action/ }));
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("omits a zero count rather than showing an empty badge", () => {
    render(
      <CollapsibleSection title="Needs your action" storageKey="test" count={0}>
        <p>content</p>
      </CollapsibleSection>
    );
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("keeps children mounted, so collapsing does not discard their data", async () => {
    // Hidden, not unmounted. Unmounting would re-fetch on every expand and
    // turn a layout preference into a network round trip.
    const user = userEvent.setup();
    render(
      <CollapsibleSection title="Needs your action" storageKey="test">
        <p>Two shifts unfilled</p>
      </CollapsibleSection>
    );

    await user.click(screen.getByRole("button", { name: /Needs your action/ }));
    expect(screen.getByText("Two shifts unfilled", { ignore: "" })).toBeInTheDocument();
  });
});
