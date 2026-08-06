/**
 * Two endpoints that answered a question they had no business answering.
 *
 * Registration replied `409 "Email already registered"`, which handed an
 * unauthenticated caller exactly the fact `/api/forgot-password` goes to
 * deliberate lengths to hide — constant response text, and the send left
 * unawaited to close the timing channel. A list of a company's addresses posted
 * at `/api/register` sorted the real ones from the invented ones, and the
 * confirmed ones then feed credential stuffing or a convincing reset phish. An
 * enumeration defence is worth nothing while a sibling answers the same
 * question directly.
 *
 * Marking a notification read had the smaller version of the same thing:
 * somebody else's id answered "Not authorized" (403) while a non-existent one
 * answered 404, so the pair distinguished real ids from invented ones — under a
 * comment claiming the endpoint never confirms a notification exists.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted — must be declared in the test file itself, not in a helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const sendDuplicate = vi.fn().mockResolvedValue(undefined);
vi.mock("@/services/email.service", () => ({
  EmailService: class {
    sendVerificationEmail = vi.fn().mockResolvedValue(undefined);
    sendPasswordResetEmail = vi.fn().mockResolvedValue(undefined);
    sendInvitationEmail = vi.fn().mockResolvedValue(undefined);
    sendDuplicateRegistrationEmail = (email: string) => sendDuplicate(email);
  },
}));

import { POST as register } from "@/app/api/register/route";
import { PATCH as markRead } from "@/app/api/organizations/[orgId]/notifications/[id]/read/route";
import { NotificationService } from "@/services/notification.service";
import { asUser } from "../helpers/session";
import { ctx, jsonReq, req, bodyOf } from "../helpers/route";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const notifications = new NotificationService();

const CREDENTIALS = {
  name: "Somebody",
  password: "SecurePass1!",
  confirmPassword: "SecurePass1!",
};

function signUp(email: string) {
  return register(jsonReq("POST", { ...CREDENTIALS, email }));
}

beforeEach(async () => {
  await cleanDatabase();
  sendDuplicate.mockClear();
});

describe("registering with an address that is already taken", () => {
  it("answers exactly as it does for a free one", async () => {
    const first = await signUp("taken@example.com");
    const second = await signUp("taken@example.com");

    expect(second.status).toBe(first.status);
    expect(await bodyOf(second)).toEqual(await bodyOf(first));
  });

  it("is a 201, not a 409", async () => {
    await signUp("taken@example.com");
    expect((await signUp("taken@example.com")).status).toBe(201);
  });

  /*
   * The id was in the body on the create path and absent otherwise, which put
   * the distinction straight back after the status code stopped carrying it.
   * Nothing consumes it — the form redirects to /verify-email on any 2xx.
   */
  it("returns no user id on either path", async () => {
    const body = await bodyOf(await signUp("fresh@example.com"));
    expect(body).not.toHaveProperty("userId");
  });

  it("creates no second account", async () => {
    await signUp("taken@example.com");
    await signUp("taken@example.com");

    expect(
      await prisma.user.count({ where: { email: "taken@example.com" } })
    ).toBe(1);
  });

  it("leaves the original account's name alone", async () => {
    await register(
      jsonReq("POST", { ...CREDENTIALS, name: "First", email: "taken@example.com" })
    );
    await register(
      jsonReq("POST", { ...CREDENTIALS, name: "Second", email: "taken@example.com" })
    );

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: "taken@example.com" },
    });
    expect(user.name).toBe("First");
  });

  // The attempt is not silent to the one person entitled to know about it.
  it("tells the account holder somebody tried", async () => {
    await signUp("taken@example.com");
    sendDuplicate.mockClear();
    await signUp("taken@example.com");

    await vi.waitFor(() => {
      expect(sendDuplicate).toHaveBeenCalledWith("taken@example.com");
    });
  });

  it("does not email anybody when the address is free", async () => {
    await signUp("brandnew@example.com");
    expect(sendDuplicate).not.toHaveBeenCalled();
  });

  it("still creates the account when the address is free", async () => {
    expect((await signUp("brandnew@example.com")).status).toBe(201);
    expect(
      await prisma.user.count({ where: { email: "brandnew@example.com" } })
    ).toBe(1);
  });
});

describe("marking a notification read", () => {
  let tenant: Tenant;
  let theirs: string;

  beforeEach(async () => {
    tenant = await createTenant("notif");
    await notifications.notify(
      tenant.orgId,
      tenant.manager.userId,
      "test",
      "Not yours",
      "Body"
    );
    const rows = await notifications.getNotifications(
      tenant.manager.userId,
      tenant.orgId
    );
    theirs = rows[0].id;
  });

  /*
   * A 403 confirms the row is real. The organisation check beside it already
   * refused to say so, so the two disagreed about what was being protected.
   */
  it("says not found for somebody else's, not forbidden", async () => {
    asUser(tenant.staff.userId);

    const res = await markRead(
      req("PATCH"),
      ctx({ orgId: tenant.orgId, id: theirs })
    );

    expect(res.status).toBe(404);
    expect(await bodyOf(res)).toMatchObject({ error: "Notification not found" });
  });

  // The point of matching them: a real id and an invented one are now
  // indistinguishable to somebody who owns neither.
  it("answers identically for an id that does not exist", async () => {
    asUser(tenant.staff.userId);

    const real = await markRead(
      req("PATCH"),
      ctx({ orgId: tenant.orgId, id: theirs })
    );
    const invented = await markRead(
      req("PATCH"),
      ctx({ orgId: tenant.orgId, id: "no-such-notification" })
    );

    expect(invented.status).toBe(real.status);
    expect(await bodyOf(invented)).toEqual(await bodyOf(real));
  });

  it("leaves the notification unread when it refuses", async () => {
    asUser(tenant.staff.userId);
    await markRead(req("PATCH"), ctx({ orgId: tenant.orgId, id: theirs }));

    const row = await prisma.notification.findUniqueOrThrow({
      where: { id: theirs },
    });
    expect(row.isRead).toBe(false);
  });

  it("still lets the owner mark their own", async () => {
    asUser(tenant.manager.userId);

    const res = await markRead(
      req("PATCH"),
      ctx({ orgId: tenant.orgId, id: theirs })
    );

    expect(res.status).toBe(200);
    const row = await prisma.notification.findUniqueOrThrow({
      where: { id: theirs },
    });
    expect(row.isRead).toBe(true);
  });
});
