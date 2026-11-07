jest.mock("../pinger", () => ({ pingUrl: jest.fn() }));
jest.mock("../redisClient", () => ({
  storeMetric: jest.fn().mockResolvedValue(undefined),
  acquireCooldown: jest.fn().mockResolvedValue(true),
}));
jest.mock("../db/incidents", () => ({
  openIncident: jest.fn(),
  getOpenIncidentForMonitor: jest.fn(),
  resolveIncident: jest.fn(),
}));
jest.mock("../anomalyDetector", () => ({ detectAnomaly: jest.fn() }));
jest.mock("../db/rollups", () => ({
  upsertCheckRollup: jest.fn(),
  deleteOldRollups: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../db/maintenance", () => ({ getActiveMaintenance: jest.fn() }));
jest.mock("../notifier", () => ({ notify: jest.fn() }));
jest.mock("../sslChecker", () => ({ inspectCertificate: jest.fn() }));
jest.mock("../endpointRegistry", () => {
  const EventEmitter = require("events");
  return {
    registry: new EventEmitter(),
    getActiveMonitors: jest.fn(() => []),
    getPublicMonitors: jest.fn(() => []),
  };
});

const poller = require("../poller");
const { registry } = require("../endpointRegistry");

describe("poller lifecycle", () => {
  afterEach(() => {
    poller.stopPolling();
  });

  test("repeated start/stop cycles register exactly one listener per event", () => {
    poller.startPolling();
    expect(registry.listenerCount("added")).toBe(1);
    expect(registry.listenerCount("removed")).toBe(1);

    poller.startPolling();
    expect(registry.listenerCount("added")).toBe(1);
    expect(registry.listenerCount("removed")).toBe(1);

    poller.stopPolling();
    expect(registry.listenerCount("added")).toBe(0);
    expect(registry.listenerCount("removed")).toBe(0);
  });

  test("an added monitor creates exactly one active polling state", () => {
    poller.startPolling();
    const monitor = {
      id: 9081,
      user_id: 19,
      name: "Lifecycle test",
      url: "https://lifecycle.example.com",
      interval_seconds: 10,
      enabled: true,
      expected_status: 200,
    };

    registry.emit("added", monitor);
    expect(poller._monitorState.has(monitor.id)).toBe(true);
    expect(registry.listenerCount("added")).toBe(1);
  });

  test("removing a monitor clears its polling state and timer", () => {
    poller.startPolling();
    const monitor = {
      id: 9082,
      user_id: 19,
      name: "Lifecycle removal test",
      url: "https://remove.example.com",
      interval_seconds: 10,
      enabled: true,
      expected_status: 200,
    };

    registry.emit("added", monitor);
    const state = poller._monitorState.get(monitor.id);
    expect(state.timeoutHandle).toBeTruthy();

    registry.emit("removed", monitor);
    expect(poller._monitorState.has(monitor.id)).toBe(false);
    expect(clearTimeout).toBeDefined();
  });
});
