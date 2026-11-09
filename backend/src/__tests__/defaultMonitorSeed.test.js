require("dotenv").config();

const pool = require("../db/pool");
const { seedDefaultMonitors } = require("../db/monitors");

describe("default monitor seeding", () => {
  let adminId;
  let cappedAdminId;

  beforeAll(async () => {
    const suffix = Date.now();
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, role, name)
       VALUES ($1, 'test-hash', 'admin', 'Sample Seed Test')
       RETURNING id`,
      [`seed_admin_${suffix}`]
    );
    adminId = result.rows[0].id;

    const capped = await pool.query(
      `INSERT INTO users (username, password_hash, role, name)
       VALUES ($1, 'test-hash', 'admin', 'Capped Seed Test')
       RETURNING id`,
      [`seed_capped_admin_${suffix}`]
    );
    cappedAdminId = capped.rows[0].id;
  });

  afterAll(async () => {
    if (adminId) await pool.query("DELETE FROM users WHERE id = $1", [adminId]).catch(() => {});
    if (cappedAdminId) await pool.query("DELETE FROM users WHERE id = $1", [cappedAdminId]).catch(() => {});
    await pool.end().catch(() => {});
  });

  test("seeds five sample monitors only when the admin has no monitors", async () => {
    expect(await seedDefaultMonitors(adminId)).toBe(5);
    expect(await seedDefaultMonitors(adminId)).toBe(0);

    const { rows } = await pool.query(
      "SELECT name, url, enabled, is_public FROM monitors WHERE user_id = $1 ORDER BY id",
      [adminId]
    );
    expect(rows).toHaveLength(5);
    expect(rows.every((monitor) => monitor.enabled && monitor.is_public)).toBe(true);
    expect(rows.map((monitor) => monitor.name)).toEqual([
      "Google", "GitHub", "Cloudflare", "HTTPBin", "JSONPlaceholder",
    ]);
  });

  test("never seeds more monitors than the configured account quota", async () => {
    const previous = process.env.MAX_MONITORS_PER_USER;
    process.env.MAX_MONITORS_PER_USER = "2";
    try {
      expect(await seedDefaultMonitors(cappedAdminId)).toBe(2);
      const { rows } = await pool.query(
        "SELECT id FROM monitors WHERE user_id = $1",
        [cappedAdminId]
      );
      expect(rows).toHaveLength(2);
    } finally {
      if (previous === undefined) delete process.env.MAX_MONITORS_PER_USER;
      else process.env.MAX_MONITORS_PER_USER = previous;
    }
  });
});
