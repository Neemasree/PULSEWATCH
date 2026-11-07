const { getDatabaseSslConfig } = require("../db/poolConfig");

describe("PostgreSQL TLS configuration", () => {
  test.each([
    "postgres://user:pass@localhost:5432/pulsewatch",
    "postgres://user:pass@127.0.0.1:5432/pulsewatch",
    "postgres://user:pass@[::1]:5432/pulsewatch",
  ])("does not force TLS for local database %s", (url) => {
    expect(getDatabaseSslConfig(url)).toBe(false);
  });

  test("verifies certificates for hosted Postgres by default", () => {
    expect(getDatabaseSslConfig("postgres://user:pass@db.example.com:5432/app"))
      .toEqual({ rejectUnauthorized: true });
  });

  test("allows explicit provider-specific certificate verification opt-out", () => {
    expect(getDatabaseSslConfig(
      "postgres://user:pass@db.example.com:5432/app",
      undefined,
      "false"
    )).toEqual({ rejectUnauthorized: false });
  });

  test("allows explicit TLS disable for local development", () => {
    expect(getDatabaseSslConfig(
      "postgres://user:pass@db.example.com:5432/app",
      "false"
    )).toBe(false);
  });

  test("does not mistake domains containing localhost as local hosts", () => {
    expect(getDatabaseSslConfig("postgres://user:pass@notlocalhost.example.com/app"))
      .toEqual({ rejectUnauthorized: true });
  });
});
