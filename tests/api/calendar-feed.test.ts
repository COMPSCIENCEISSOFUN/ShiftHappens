// @vitest-environment node
/**
 * The feed endpoint, at the level a calendar client actually meets it.
 *
 * The service tests cover WHAT the calendar contains. These cover the four
 * things a client checks before it will look at the body at all — and every one
 * of them is invisible from the service: a correct calendar served with the
 * wrong Content-Type is simply not a calendar as far as Google is concerned.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET as feed } from "@/app/api/calendar/[token]/route";
import { ctx, req } from "../helpers/route";
import { CalendarFeedService } from "@/services/calendar-feed.service";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const service = new CalendarFeedService();
let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("calendar-route");
});

const token = async () =>
  (await service.getFeedToken(tenant.staff.membershipId)).token;

describe("what a calendar client is served", () => {
  it("declares itself as a calendar", async () => {
    const res = await feed(req("GET"), ctx({ token: await token() }));

    expect(res.status).toBe(200);
    // Without this exact type most clients refuse the URL outright, whatever
    // the body says.
    expect(res.headers.get("content-type")).toContain("text/calendar");
    expect(await res.text()).toContain("BEGIN:VCALENDAR");
  });

  /*
   * A feed's entire value is being current. A cache between the client and here
   * serving last hour's rota would be worse than no feed, because nothing about
   * it looks stale.
   */
  it("refuses to be cached", async () => {
    const res = await feed(req("GET"), ctx({ token: await token() }));

    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("says nothing at all about a token it does not know", async () => {
    const res = await feed(req("GET"), ctx({ token: "not-a-real-token" }));

    // A regenerated URL and somebody guessing look identical here, and neither
    // is owed an explanation.
    expect(res.status).toBe(404);
  });

  /*
   * The caller is a machine on a timer. A bare 429 with no interval is backed
   * off on whatever schedule the client likes, and several simply retry at the
   * same rate — so the refusal has to carry the number.
   */
  it("tells a hammering client how long to wait", async () => {
    const value = await token();
    let last;
    for (let i = 0; i < 35; i++) {
      last = await feed(req("GET"), ctx({ token: value }));
    }

    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
