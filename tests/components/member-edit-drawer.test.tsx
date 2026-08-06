// @vitest-environment jsdom
/**
 * The Members table stopped being an editor.
 *
 * Every row used to carry three dropdowns plus a checkbox per department —
 * around seventy-seven controls for eleven members and three departments, and
 * three lines of height per row because the department column is a vertical
 * stack that grows as departments are added. The mobile view on the same page
 * had already settled on badges and one line per member, so the two disagreed
 * about what the page was for.
 *
 * The editing moved here. What matters in these tests is that nothing was lost
 * in the move — particularly the guards, which are the part it would be easy to
 * drop while rearranging markup: self-demotion, self-deactivation, and the
 * three separate permissions the controls answer to.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MemberEditDrawer,
  type DrawerMember,
} from "@/components/members/member-edit-drawer";
import type { SeniorityAssessment } from "@/lib/seniority";

const KITCHEN = { id: "d1", name: "Kitchen" };
const BAR = { id: "d2", name: "Bar" };

function member(overrides: Partial<DrawerMember> = {}): DrawerMember {
  return {
    id: "m1",
    role: "staff",
    status: "active",
    employmentType: "casual",
    customRole: null,
    user: { id: "u1", name: "Alex Rivera", email: "alex@oceangrill.com" },
    departmentMemberships: [{ department: KITCHEN }],
    ...overrides,
  };
}

const SENIOR: SeniorityAssessment = {
  level: "senior",
  overridden: false,
  completedShifts: 49,
  explanation: "Senior — 49 completed shifts",
} as SeniorityAssessment;

function renderDrawer(props: Partial<Parameters<typeof MemberEditDrawer>[0]> = {}) {
  const handlers = {
    onUpdateRole: vi.fn(),
    onUpdateEmploymentType: vi.fn(),
    onUpdateCustomRole: vi.fn(),
    onUpdateSeniority: vi.fn(),
    onToggleDepartment: vi.fn(),
    onToggleStatus: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <MemberEditDrawer
      member={member()}
      departments={[KITCHEN, BAR]}
      customRoles={[]}
      seniority={SENIOR}
      isSelf={false}
      canUpdateRole
      canUpdateSeniority
      canDeactivate
      {...handlers}
      {...props}
    />
  );
  return handlers;
}

describe("what moved out of the table", () => {
  it("carries every control the row used to hold", () => {
    renderDrawer();

    expect(screen.getByLabelText("Role")).toBeInTheDocument();
    expect(screen.getByLabelText("Employment type")).toBeInTheDocument();
    expect(screen.getByLabelText("Seniority")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Kitchen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
  });

  it("passes a role change straight through", async () => {
    const { onUpdateRole } = renderDrawer();
    await userEvent.selectOptions(screen.getByLabelText("Role"), "manager");
    expect(onUpdateRole).toHaveBeenCalledWith("u1", "manager");
  });

  /*
   * The department handler takes the CURRENT set and toggles one entry. Sending
   * `[deptId]` instead would replace the whole set — the bug the checkbox
   * control was built to fix, and exactly the kind of thing that gets
   * reintroduced when markup is rearranged.
   */
  it("toggles one department without disturbing the others", async () => {
    const { onToggleDepartment } = renderDrawer();
    await userEvent.click(screen.getByRole("checkbox", { name: "Bar" }));

    expect(onToggleDepartment).toHaveBeenCalledWith("u1", "staff", "d2", ["d1"]);
  });

  it("shows which departments the member is already in", () => {
    renderDrawer();
    expect(screen.getByRole("checkbox", { name: "Kitchen" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Bar" })).not.toBeChecked();
  });

  /*
   * The evidence behind a seniority level travelled with the control. A level
   * that decides who gets rostered must never be an unexplained assertion — and
   * the count also stays on the table itself, so it is visible without opening
   * anything.
   */
  it("keeps the explanation beside the seniority control", () => {
    renderDrawer();
    expect(screen.getByText("Senior — 49 completed shifts")).toBeInTheDocument();
  });
});

describe("the guards survived the move", () => {
  it("will not let anyone change their own role", () => {
    renderDrawer({ isSelf: true });
    expect(screen.getByLabelText("Role")).toBeDisabled();
    expect(screen.getByText(/cannot change your own role/i)).toBeInTheDocument();
  });

  it("will not let anyone deactivate themselves", () => {
    renderDrawer({ isSelf: true });
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeDisabled();
  });

  // Three separate permissions, and a default manager holds the seniority one
  // without holding the other two. Gating them together would take the one
  // control a manager is meant to use away from them.
  it("disables role and employment type without members:update_role", () => {
    renderDrawer({ canUpdateRole: false });
    expect(screen.getByLabelText("Role")).toBeDisabled();
    expect(screen.getByLabelText("Employment type")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Kitchen" })).toBeDisabled();
  });

  it("leaves seniority alone when only that permission is held", () => {
    renderDrawer({ canUpdateRole: false, canDeactivate: false });
    expect(screen.getByLabelText("Seniority")).toBeEnabled();
  });

  it("hides the status button entirely without members:deactivate", () => {
    renderDrawer({ canDeactivate: false });
    expect(screen.queryByRole("button", { name: /Deactivate/ })).toBeNull();
  });
});

describe("what each member gets asked", () => {
  // Admins are not rostered, so a level for them would be a number with nothing
  // behind it and nothing reading it.
  it("asks an admin for neither employment type nor seniority", () => {
    renderDrawer({ member: member({ role: "company_admin" }) });
    expect(screen.queryByLabelText("Employment type")).toBeNull();
    expect(screen.queryByLabelText("Seniority")).toBeNull();
  });

  it("asks a manager for seniority but not employment type", () => {
    renderDrawer({ member: member({ role: "manager" }) });
    expect(screen.queryByLabelText("Employment type")).toBeNull();
    expect(screen.getByLabelText("Seniority")).toBeInTheDocument();
  });

  it("offers a custom role only when the organisation has one", () => {
    renderDrawer();
    expect(screen.getByText(/No custom roles defined/)).toBeInTheDocument();
  });

  it("assigns a custom role by name", async () => {
    const { onUpdateCustomRole } = renderDrawer({
      customRoles: [{ id: "cr1", displayLabel: "Shift Lead" }],
    });

    await userEvent.selectOptions(
      screen.getByLabelText("Assign a custom role"),
      "cr1"
    );
    expect(onUpdateCustomRole).toHaveBeenCalledWith("u1", "cr1");
  });

  /*
   * `effectivePermissions` REPLACES the system bundle when a custom role is
   * present — a manager holding a role with three permissions ticked has three
   * permissions, not the manager bundle plus three. That is deliberate, and it
   * is the only way a role can take something away. But it is invisible, and a
   * purple chip sitting next to "Manager" reads as an addition, so the panel
   * says which it is.
   */
  it("says a custom role replaces the system bundle rather than adding to it", () => {
    renderDrawer({
      member: member({
        role: "manager",
        customRole: { id: "cr1", name: "test_manager", displayLabel: "Test Manager" },
      }),
    });

    expect(screen.getByText(/Replaces the Manager permissions/)).toBeInTheDocument();
  });

  it("offers to remove one that is already held", async () => {
    const { onUpdateCustomRole } = renderDrawer({
      member: member({
        customRole: { id: "cr1", name: "shift_lead", displayLabel: "Shift Lead" },
      }),
    });

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onUpdateCustomRole).toHaveBeenCalledWith("u1", null);
  });
});

describe("getting out of it", () => {
  it("closes on Escape", async () => {
    const { onClose } = renderDrawer();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  // Clicking away is how most people dismiss a panel, and it should not require
  // aiming at a small × — nor a mouse, which is why the backdrop is a button.
  it("closes when the backdrop is activated", async () => {
    const { onClose } = renderDrawer();
    await userEvent.click(screen.getByRole("button", { name: /Close Alex Rivera/ }));
    expect(onClose).toHaveBeenCalled();
  });

  it("names the member it is editing", () => {
    renderDrawer();
    expect(
      screen.getByRole("dialog", { name: "Edit Alex Rivera" })
    ).toBeInTheDocument();
  });
});
