// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import {
  GET,
  POST,
} from "@/app/api/organizations/[orgId]/certification-definitions/route";
import {
  DELETE,
  PATCH,
} from "@/app/api/organizations/[orgId]/certification-definitions/[definitionId]/route";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { asUser } from "../helpers/session";
import { ctx, jsonReq, req } from "../helpers/route";

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("cert-def-route");
  vi.clearAllMocks();
});

describe("certification definition routes", () => {
  it("lets active members read the catalogue and reports management capability", async () => {
    asUser(tenant.staff.userId);
    const response = await GET(req(), ctx({ orgId: tenant.orgId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ definitions: [], canManage: false });
  });

  it("allows Company Admin to create and update a definition", async () => {
    asUser(tenant.admin.userId);
    const createdResponse = await POST(
      jsonReq("POST", {
        name: "Food Safety",
        departmentRequirements: [
          { departmentId: tenant.departmentId, isRequired: true },
        ],
      }),
      ctx({ orgId: tenant.orgId })
    );
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();

    const updatedResponse = await PATCH(
      jsonReq("PATCH", { isActive: false }),
      ctx({ orgId: tenant.orgId, definitionId: created.id })
    );
    expect(updatedResponse.status).toBe(200);
  });

  it("forbids Manager and Staff mutations", async () => {
    for (const userId of [tenant.manager.userId, tenant.staff.userId]) {
      asUser(userId);
      const response = await POST(
        jsonReq("POST", { name: "Blocked", departmentRequirements: [] }),
        ctx({ orgId: tenant.orgId })
      );
      expect(response.status).toBe(403);
    }
  });

  it("does not delete a definition through another organization", async () => {
    asUser(tenant.admin.userId);
    const createdResponse = await POST(
      jsonReq("POST", { name: "First Aid", departmentRequirements: [] }),
      ctx({ orgId: tenant.orgId })
    );
    const created = await createdResponse.json();
    const other = await createTenant("cert-def-route-other");

    asUser(other.admin.userId);
    const response = await DELETE(
      req(),
      ctx({ orgId: other.orgId, definitionId: created.id })
    );
    expect(response.status).toBe(404);
  });
});
