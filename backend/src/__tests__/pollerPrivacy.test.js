const poller = require("../poller");
const registry = require("../endpointRegistry");
const { client: redisClient } = require("../redisClient");
const pool = require("../db/pool");

afterAll(async () => {
  redisClient.disconnect();
  await pool.end().catch(() => {});
});

describe("polling statistics privacy", () => {
  afterEach(() => {
    poller._monitorState.clear();
    registry.notifyMonitorRemoved({ id: 501 });
    registry.notifyMonitorRemoved({ id: 502 });
  });

  test("guest metrics include only that user's monitor counts and intervals", () => {
    registry.notifyMonitorAdded({ id: 501, user_id: 11, enabled: false });
    registry.notifyMonitorAdded({ id: 502, user_id: 22, enabled: false });
    poller._monitorState.set(501, { checkCount: 3, currentIntervalMs: 15000 });
    poller._monitorState.set(502, { checkCount: 9, currentIntervalMs: 30000 });

    const userA = poller.getPollingState("11", false);
    const userB = poller.getPollingState("22", false);
    const admin = poller.getPollingState(null, true);

    expect(userA.monitorCount).toBe(1);
    expect(userA.totalAdaptiveChecks).toBe(3);
    expect(userA.monitorIntervals).toEqual({ 501: 15000 });

    expect(userB.monitorCount).toBe(1);
    expect(userB.totalAdaptiveChecks).toBe(9);
    expect(userB.monitorIntervals).toEqual({ 502: 30000 });

    expect(admin.monitorCount).toBe(2);
    expect(admin.totalAdaptiveChecks).toBe(12);
  });
});
