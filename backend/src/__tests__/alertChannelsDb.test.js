jest.mock("../db/pool", () => ({ connect: jest.fn() }));

const pool = require("../db/pool");
const { createChannel } = require("../db/alertChannels");

describe("alert channel quota transaction", () => {
  let client;

  beforeEach(() => {
    jest.clearAllMocks();
    client = {
      query: jest.fn(async (sql) => {
        if (sql === "SELECT COUNT(*)::int AS count FROM alert_channels WHERE user_id = $1") {
          return { rows: [{ count: 0 }] };
        }
        if (sql.includes("INSERT INTO alert_channels")) {
          return { rows: [{
            id: 9,
            user_id: 12,
            type: "webhook",
            name: "Primary",
            target_url: "https://hooks.example.com/private",
            enabled: true,
            events: ["down"],
          }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(client);
  });

  test("locks the owner quota before counting and inserting", async () => {
    const channel = await createChannel({
      userId: 12,
      type: "webhook",
      name: "Primary",
      target_url: "https://hooks.example.com/private",
      enabled: true,
      events: ["down"],
    });

    const sql = client.query.mock.calls.map(([query]) => query);
    const lockIndex = sql.findIndex((query) => query.includes("pg_advisory_xact_lock"));
    const countIndex = sql.indexOf("SELECT COUNT(*)::int AS count FROM alert_channels WHERE user_id = $1");
    const insertIndex = sql.findIndex((query) => query.includes("INSERT INTO alert_channels"));

    expect(lockIndex).toBeGreaterThan(sql.indexOf("BEGIN"));
    expect(countIndex).toBeGreaterThan(lockIndex);
    expect(insertIndex).toBeGreaterThan(countIndex);
    expect(sql).toContain("COMMIT");
    expect(client.release).toHaveBeenCalled();
    expect(channel.target_url).toBe("https://hooks.example.com/***");
  });

  test("rolls back and refuses a channel when the owner limit is reached", async () => {
    client.query.mockImplementation(async (sql) => {
      if (sql === "SELECT COUNT(*)::int AS count FROM alert_channels WHERE user_id = $1") {
        return { rows: [{ count: 10 }] };
      }
      return { rows: [] };
    });

    await expect(createChannel({
      userId: 12,
      type: "webhook",
      name: "Overflow",
      target_url: "https://hooks.example.com/private",
      enabled: true,
      events: ["down"],
    })).rejects.toMatchObject({ code: "CHANNEL_LIMIT_REACHED" });

    const sql = client.query.mock.calls.map(([query]) => query);
    expect(sql).toContain("ROLLBACK");
    expect(sql.some((query) => query.includes("INSERT INTO alert_channels"))).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });
});
