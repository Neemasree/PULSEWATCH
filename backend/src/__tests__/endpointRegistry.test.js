jest.mock("../db/monitors", () => ({
  getAllMonitors: jest.fn(),
}));

const { getAllMonitors } = require("../db/monitors");
const {
  loadFromDb,
  getAllMonitors: getCachedMonitors,
  getActiveMonitors,
  getMonitorsForUser,
  registry,
} = require("../endpointRegistry");

describe("endpoint registry restart hydration", () => {
  afterEach(() => {
    registry.removeAllListeners();
    getAllMonitors.mockReset();
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
