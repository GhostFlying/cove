import { describe, expect, it } from "vitest";
import {
  BUSINESS_EVENT_CAPABILITY,
  BUSINESS_KINDS,
  BusinessCursorSchema,
  BusinessFrameSchema,
  BusinessSubscribeSchema,
  businessFilterIdentity,
} from "../dist/business-events.js";
import { M0_CAPABILITIES, REQUIRED_CAPABILITIES, evaluateWsUpgrade } from "../dist/bootstrap.js";

describe("business event contract", () => {
  it("binds normalized kinds without widening mandatory mixed-version capabilities", () => {
    expect(businessFilterIdentity({ kinds: ["task", "repo", "task"] })).toBe("repo,task");
    expect(businessFilterIdentity({ kinds: [...BUSINESS_KINDS] })).toBe(businessFilterIdentity({}));
    expect(M0_CAPABILITIES).toContain(BUSINESS_EVENT_CAPABILITY);
    expect(REQUIRED_CAPABILITIES).not.toContain(BUSINESS_EVENT_CAPABILITY);
    expect(
      BusinessSubscribeSchema.safeParse({ type: "subscribe", filter: { taskIds: ["task"] } })
        .success,
    ).toBe(false);
  });
  it("requires complete cursor identity and an explicit current-view history policy", () => {
    const cursor = {
      serverId: "s",
      relayInstanceId: "i",
      streamId: "g",
      sequence: 4,
      filter: "task",
    };
    expect(BusinessCursorSchema.safeParse(cursor).success).toBe(true);
    expect(BusinessCursorSchema.safeParse({ ...cursor, sequence: -1 }).success).toBe(false);
    expect(BusinessCursorSchema.safeParse({ sequence: 4 }).success).toBe(false);
    expect(
      BusinessFrameSchema.safeParse({ type: "snapshot-end", snapshotId: "snap", pages: 1, cursor })
        .success,
    ).toBe(false);
    expect(
      BusinessFrameSchema.safeParse({
        type: "snapshot-end",
        snapshotId: "snap",
        pages: 1,
        cursor,
        history: "latest-and-active-runs-unresolved-operations",
      }).success,
    ).toBe(true);
  });
  it("uses the same Host/Origin boundary for independent business and terminal sockets", () => {
    const request = {
      path: "/events",
      host: "127.0.0.1:32123",
      boundAuthority: "127.0.0.1:32123",
      allowedOrigins: [],
      capacityAvailable: true,
    };
    expect(evaluateWsUpgrade(request)).toBe("accepted");
    expect(evaluateWsUpgrade({ ...request, origin: "https://unapproved.invalid" })).toBe(
      "forbidden",
    );
    expect(evaluateWsUpgrade({ ...request, path: "/unknown" })).toBe("forbidden");
    expect(evaluateWsUpgrade({ ...request, capacityAvailable: false })).toBe("busy");
  });
});
