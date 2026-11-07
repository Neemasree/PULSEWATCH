const { parseCookies } = require("../socketHandler");
const { client: redisClient } = require("../redisClient");
const pool = require("../db/pool");

afterAll(async () => {
  redisClient.disconnect();
  await pool.end().catch(() => {});
});

describe("Socket.IO cookie parsing", () => {
  test("decodes values containing encoded separators", () => {
    expect(parseCookies("access_token=a%3Db; csrf_token=csrf%2Bvalue"))
      .toEqual({ access_token: "a=b", csrf_token: "csrf+value" });
  });

  test("ignores malformed percent encoding without throwing", () => {
    expect(() => parseCookies("access_token=%ZZ; theme=dark")).not.toThrow();
    expect(parseCookies("access_token=%ZZ; theme=dark"))
      .toEqual({ access_token: "", theme: "dark" });
  });

  test("preserves equals signs inside cookie values", () => {
    expect(parseCookies("token=part1=part2")).toEqual({ token: "part1=part2" });
  });
});
