jest.mock("../db/monitors", () => ({
  getAllMonitors: jest.fn(),
}));

const { getAllMonitors } = require("../db/monitors");
const {
  loadFromDb,
  getAllMonitors: getCachedMonitors,
  getActiveMonitors,
  getMonitorsForUser,
  notifyMonitorAdded,
  notifyMonitorUpdated,
  notifyMonitorRemoved,
  registry,
} = require("../endpointRegistry");

describe("endpoint registry restart hydration", () => {
  afterEach(() => {
    registry.removeAllListeners();
    getAllMonitors.mockReset();
  });

  test("active edits emit update while pause and resume emit lifecycle events", () => {
    const original = { id: 901, user_id: 19, enabled: true, name: "Original", url: "https://a.example.com" };
    const edited = { ...original, name: "Edited" };
    const paused = { ...edited, enabled: false };
    const resumed = { ...paused, enabled: true };

    const events = [];
    registry.on("added", (monitor) => events.push(["added", monitor.id]));
    registry.on("updated", (next, previous) => events.push(["updated", next.id, previous.name]));
    registry.on("removed", (monitor) => events.push(["removed", monitor.id]));

    notifyMonitorAdded(original);
    events.length = 0;

    notifyMonitorUpdated(original, edited);
    expect(events).toEqual([["updated", 901, "Original"]]);
    expect(getCachedMonitors().find((monitor) => monitor.id === 901)).toEqual(edited);

    notifyMonitorUpdated(edited, paused);
    expect(events[1]).toEqual(["removed", 901]);
    expect(getCachedMonitors().find((monitor) => monitor.id === 901)).toEqual(paused);
    expect(getActiveMonitors().some((monitor) => monitor.id === 901)).toBe(false);

    notifyMonitorUpdated(paused, resumed);
    expect(events[2]).toEqual(["added", 901]);
    expect(getActiveMonitors().some((monitor) => monitor.id === 901)).toBe(true);

    notifyMonitorRemoved(resumed);
    expect(getCachedMonitors().some((monitor) => monitor.id === 901)).toBe(false);
  });

  test("restores paused monitors for ownership while polling only enabled monitors", async () => {
    const enabled = { id: 1, user_id: 10, enabled: true, url: "https://up.example.com" };
    const paused = { id: 2, user_id: 10, enabled: false, url: "https://paused.example.com" };
    const otherUser = { id: 3, user_id: 20, enabled: false, url: "https://other.example.com" };
    getAllMonitors.mockResolvedValue([enabled, paused, otherUser]);

    await loadFromDb();

    expect(getCachedMonitors()).toHaveLength(3);
    expect(getActiveMonitors()).toEqual([enabled]);
    expect(getMonitorsForUser("10", false)).toEqual([enabled, paused]);
    expect(getMonitorsForUser("20", false)).toEqual([otherUser]);
  });
});
