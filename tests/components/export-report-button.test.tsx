// @vitest-environment jsdom
/**
 * The control that made a finished feature reachable.
 *
 * `GET /reports/export` was written in July with its permission, its plan gate,
 * its department scoping and its own service tests, and nothing ever called it.
 * The pricing table sold "PDF report export" as a Pro feature with no way to
 * reach it — built-and-uncalled, the same shape as `deleteOverride` and the
 * leave approve/reject routes before it.
 *
 * These tests are about the two gates and the states, not about the PDF. What
 * the document contains is `pdf-report.service.test.ts`, and whether a manager
 * may only see their own departments is `manager-scope-leaks.test.ts`. What is
 * pinned here is that the button appears for exactly the people who can use it,
 * and that pressing it twice does not build two reports.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ExportReportButton,
  filenameFromDisposition,
} from "@/components/dashboard/export-report-button";
import { PermissionProvider } from "@/components/layout/permission-provider";
import { PlanProvider } from "@/components/layout/plan-provider";
import type { SubscriptionTier } from "@/lib/subscription-tiers";

const EXPORT_URL = "/api/organizations/org-1/reports/export";

/**
 * `PlanProvider` is given no `orgId` on purpose: with one it fetches usage
 * counts on mount, and this file stubs `fetch` to watch the export request. A
 * second caller on the same stub would make the assertions below ambiguous.
 */
function renderButton(permissions: string[], tier: SubscriptionTier = "pro") {
  render(
    <PlanProvider tier={tier}>
      <PermissionProvider permissions={permissions}>
        <ExportReportButton orgId="org-1" />
      </PermissionProvider>
    </PlanProvider>
  );
}

function pdfResponse() {
  return {
    ok: true,
    headers: new Headers({
      "Content-Disposition":
        'attachment; filename="workforce-report-2026-08-09.pdf"',
    }),
    blob: async () => new Blob(["%PDF-1.3"], { type: "application/pdf" }),
  };
}

function theButton() {
  return screen.queryByRole("button", { name: /Export PDF|Building|Try again/ });
}

/**
 * jsdom implements neither object-URL method, and this component is not under
 * test for how a browser saves a file — only for whether it asked for one.
 * Assigned through a narrow view of `URL` rather than a cast to `any`, which
 * eslint refuses.
 */
type ObjectUrlHost = {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
};
const urlHost = URL as unknown as ObjectUrlHost;

/*
 * The spy itself, not a separate `vi.fn()` handed to it.
 *
 * `vi.fn()` is typed as callable-or-constructable, which does not satisfy
 * `click(): void`, so passing one to `mockImplementation` is a type error. The
 * spy is what records the calls anyway — the extra mock was a second object
 * doing the first one's job.
 */
let clicked: MockInstance;

beforeEach(() => {
  urlHost.createObjectURL = vi.fn(() => "blob:stub");
  urlHost.revokeObjectURL = vi.fn();
  // Without this jsdom logs "navigation not implemented" for every download.
  clicked = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("both gates are answered before anything is offered", () => {
  it("offers nothing to a member without reports:export", () => {
    vi.stubGlobal("fetch", vi.fn());

    renderButton([], "enterprise");

    expect(theButton()).not.toBeInTheDocument();
  });

  /**
   * HIDDEN, not greyed with an upgrade badge.
   *
   * The opposite of the house answer for a plan-gated checkbox, and deliberate:
   * the precedent for a plan-gated CONTROL on a page a Free organisation can
   * open is Import Members, which is simply not rendered. A greyed button is
   * still an offer.
   */
  it("offers nothing on a plan without pdf_export, even to a holder", () => {
    vi.stubGlobal("fetch", vi.fn());

    renderButton(["reports:export"], "free");

    expect(theButton()).not.toBeInTheDocument();
  });

  it("offers it when the permission and the plan both say yes", () => {
    vi.stubGlobal("fetch", vi.fn());

    renderButton(["reports:export"], "pro");

    expect(theButton()).toBeInTheDocument();
  });
});

describe("asking for the report", () => {
  it("calls the export endpoint and saves what comes back", async () => {
    const fetchMock = vi.fn().mockResolvedValue(pdfResponse());
    vi.stubGlobal("fetch", fetchMock);

    renderButton(["reports:export"]);
    await userEvent.click(theButton()!);

    expect(fetchMock).toHaveBeenCalledWith(EXPORT_URL);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  /**
   * A second press while the first is still building.
   *
   * The PDF takes seconds to render, which is exactly long enough for an
   * impatient second click, and each one is a full re-render of the document
   * server-side. The `disabled` attribute is the guard; this holds the first
   * request open with a promise that never settles to prove the guard is what
   * stops the second, rather than the test being too fast to catch it.
   */
  it("does not build a second report while the first is still going", async () => {
    let release: (value: unknown) => void = () => {};
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(held);
    vi.stubGlobal("fetch", fetchMock);

    renderButton(["reports:export"]);
    await userEvent.click(theButton()!);

    expect(screen.getByRole("button", { name: /Building/ })).toBeDisabled();

    await userEvent.click(theButton()!);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Released and awaited rather than left hanging, so the component settles
    // inside the test instead of updating state after it has finished.
    release(pdfResponse());
    expect(
      await screen.findByRole("button", { name: /Export PDF/ })
    ).toBeInTheDocument();
  });

  /**
   * A refusal has to say something.
   *
   * The route can answer 403 for a plan the client believed it had, or 500 if
   * the render fails. Either way a button that silently returns to its resting
   * label reads as "nothing happened" and gets pressed again — which is how the
   * silent sign-out failure went unnoticed for a fortnight.
   */
  it("says so when the report cannot be built", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    renderButton(["reports:export"]);
    await userEvent.click(theButton()!);

    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
    expect(screen.getByText(/Couldn't build the report/)).toBeInTheDocument();
    expect(clicked).not.toHaveBeenCalled();
  });

  it("reports a network failure the same way as a refusal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    renderButton(["reports:export"]);
    await userEvent.click(theButton()!);

    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });
});

/**
 * The server already names the file with the date it covers. Parsing that
 * rather than rebuilding it here keeps one source of truth — a second one would
 * drift, and a folder of `workforce-report.pdf (3)` tells nobody which week
 * they are looking at.
 */
describe("filenameFromDisposition", () => {
  it("takes the name the server chose", () => {
    expect(
      filenameFromDisposition(
        'attachment; filename="workforce-report-2026-08-09.pdf"'
      )
    ).toBe("workforce-report-2026-08-09.pdf");
  });

  it("falls back when the header is missing or unparseable", () => {
    expect(filenameFromDisposition(null)).toBe("workforce-report.pdf");
    expect(filenameFromDisposition("attachment")).toBe("workforce-report.pdf");
  });
});
