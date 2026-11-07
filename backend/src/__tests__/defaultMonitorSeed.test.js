require("dotenv").config();

const pool = require("../db/pool");
const { seedDefaultMonitors } = require("../db/monitors");

describe("default monitor seeding", () => {
  let adminId;

  beforeAll(async () => {
    const suffix = Date.now();
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, role, name)
       VALUES ($1, 'test-hash', 'admin', 'Sample Seed Test')
       RETURNING id`,
      [`seed_admin_${suffix}`]
    );
    adminId = result.rows[0].id;
  });

  afterAll(async () => {
    if (adminId) await pool.query("DELETE FROM users WHERE id = $1", [adminId]).catch(() => {});
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
});
