/**
 * Tests for the bulk-invite resolver.
 *
 * The resolver decides what a spreadsheet MEANT before anything is sent, and
 * the preview it produces is the only thing standing between a mistyped column
 * and forty emails to real people. So the assertions here are mostly about the
 * refusals: what it declines to guess, and what it reports rather than silently
 * fixing.
 *
 * No API keys are set, so every AI branch returns null and the alias tables are
 * on their own. That is deliberate — it pins the promise that a missing key
 * degrades the feature to "the obvious cases work" instead of breaking it, and
 * it keeps the suite deterministic and free.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { InviteImportService } from "@/services/invite-import.service";

const service = new InviteImportService();

const DEPARTMENTS = [
  { id: "dept-kitchen", name: "Kitchen" },
  { id: "dept-front", name: "Front of House" },
];

beforeEach(() => {
  // The AI paths are reached only when the tables fail; with no keys they
  // return null and the row keeps its error. Cleared explicitly because a
  // developer's own .env would otherwise make these tests hit the network.
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

describe("reading the headers", () => {
  it("accepts our own column names", async () => {
    const { rows } = await service.resolve(
      [{ Email: "a@example.com", Role: "Staff", Department: "Kitchen", "Employment Type": "Casual" }],
      DEPARTMENTS
    );

    expect(rows[0]).toMatchObject({
      email: "a@example.com",
      role: "staff",
      departmentId: "dept-kitchen",
      employmentType: "casual",
      errors: [],
    });
  });

  it("accepts the spellings people actually use", async () => {
    const { rows } = await service.resolve(
      [{ "E-Mail": "b@example.com", Position: "Supervisor", Dept: "Kitchen", "Work Type": "Full-Time" }],
      DEPARTMENTS
    );

    expect(rows[0]).toMatchObject({
      email: "b@example.com",
      role: "manager",
      departmentId: "dept-kitchen",
      employmentType: "full_time",
      errors: [],
    });
  });

  it("reports columns it ignored rather than dropping them silently", async () => {
    const { unmappedHeaders } = await service.resolve(
      [{ Email: "a@example.com", "Employee Number": "0042", "Start Date": "2026-01-01" }],
      DEPARTMENTS
    );

    expect(unmappedHeaders).toContain("Employee Number");
    expect(unmappedHeaders).toContain("Start Date");
  });

  it("numbers rows the way the spreadsheet does", async () => {
    // The reader is going to go and look at the file. Row 1 is the header, so
    // the first record is row 2 — reporting it as 1 sends them to the wrong line.
    const { rows } = await service.resolve(
      [{ Email: "a@example.com" }, { Email: "b@example.com" }],
      DEPARTMENTS
    );

    expect(rows.map((r) => r.rowNumber)).toEqual([2, 3]);
  });
});

describe("what it refuses to send", () => {
  it("rejects a row with no email", async () => {
    const { rows } = await service.resolve([{ Role: "Staff" }], DEPARTMENTS);

    expect(rows[0].errors).toContain("No email address");
  });

  it("rejects text that is plainly not an address", async () => {
    const { rows } = await service.resolve([{ Email: "N/A" }], DEPARTMENTS);

    expect(rows[0].errors.join(" ")).toMatch(/not an email/i);
  });

  it("rejects a role it does not recognise", async () => {
    const { rows } = await service.resolve(
      [{ Email: "a@example.com", Role: "Regional Vice President" }],
      DEPARTMENTS
    );

    expect(rows[0].errors.join(" ")).toMatch(/Unknown role/);
  });

  it("rejects a department the organisation does not have", async () => {
    // Never invented. A department that does not exist is a visible error the
    // admin fixes in seconds; quietly picking the nearest one puts a real
    // person on the wrong rota.
    const { rows } = await service.resolve(
      [{ Email: "a@example.com", Department: "Warehouse" }],
      DEPARTMENTS
    );

    expect(rows[0].departmentId).toBeNull();
    expect(rows[0].errors.join(" ")).toMatch(/No department called "Warehouse"/);
  });

  it("catches an address repeated inside the same file", async () => {
    /*
     * `inviteUser` would refuse the second one anyway — but one row at a time,
     * and only AFTER sending the first. The reader would see one invitation
     * succeed and an identical one fail, instead of being told before anything
     * was sent.
     */
    const { rows } = await service.resolve(
      [
        { Email: "same@example.com" },
        { Email: "other@example.com" },
        { Email: "SAME@example.com" },
      ],
      DEPARTMENTS
    );

    expect(rows[0].errors).toEqual([]);
    expect(rows[2].errors.join(" ")).toMatch(/Same address as row 2/);
  });
});

describe("what it assumes, and says so", () => {
  it("defaults a missing role and notes it", async () => {
    const { rows } = await service.resolve(
      [{ Email: "a@example.com" }],
      DEPARTMENTS
    );

    expect(rows[0].role).toBe("staff");
    expect(rows[0].notes.join(" ")).toMatch(/defaulting to staff/);
    expect(rows[0].errors).toEqual([]);
  });

  it("defaults a missing employment type and notes it", async () => {
    const { rows } = await service.resolve(
      [{ Email: "a@example.com" }],
      DEPARTMENTS
    );

    expect(rows[0].employmentType).toBe("casual");
    expect(rows[0].notes.join(" ")).toMatch(/defaulting to casual/);
  });

  it("leaves a blank department blank rather than erroring", async () => {
    // Not every organisation uses departments, and none of them should have to
    // fill in a column they do not use to get past a preview.
    const { rows } = await service.resolve(
      [{ Email: "a@example.com", Department: "" }],
      DEPARTMENTS
    );

    expect(rows[0].departmentId).toBeNull();
    expect(rows[0].errors).toEqual([]);
  });

  it("matches a department regardless of casing", async () => {
    // An exact name in the wrong case is not a job for a model.
    const { rows } = await service.resolve(
      [{ Email: "a@example.com", Department: "  front OF house " }],
      DEPARTMENTS
    );

    expect(rows[0].departmentId).toBe("dept-front");
    expect(rows[0].errors).toEqual([]);
  });

  it("lowercases the address, since that is what gets deduplicated", async () => {
    const { rows } = await service.resolve(
      [{ Email: "Mixed.Case@Example.COM" }],
      DEPARTMENTS
    );

    expect(rows[0].email).toBe("mixed.case@example.com");
  });
});

describe("without an AI key", () => {
  it("still resolves everything the tables can", async () => {
    const { rows, usedAi } = await service.resolve(
      [{ "E-mail": "a@example.com", Position: "Lead", Dept: "Kitchen" }],
      DEPARTMENTS
    );

    expect(usedAi).toBe(false);
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].role).toBe("manager");
  });

  it("reports a missing email column instead of guessing at one", async () => {
    // The header is unrecognised and there is no model to ask. Guessing which
    // column holds addresses would send invitations to whatever was in it.
    const { rows } = await service.resolve(
      [{ "Contact Point": "a@example.com", Role: "Staff" }],
      DEPARTMENTS
    );

    expect(rows[0].errors).toContain("No email address");
  });

  it("handles an empty file without throwing", async () => {
    const result = await service.resolve([], DEPARTMENTS);

    expect(result.rows).toEqual([]);
    expect(result.usedAi).toBe(false);
  });

  it("reports an unmatched department rather than hanging on the model", async () => {
    const { rows } = await service.resolve(
      [{ Email: "a@example.com", Department: "Kitchn" }],
      DEPARTMENTS
    );

    expect(rows[0].errors.join(" ")).toMatch(/No department called/);
  });
});
