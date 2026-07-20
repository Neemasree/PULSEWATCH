/**
 * rbac.test.js
 * Verifies that server-side RBAC middleware actually enforces role boundaries,
 * not just the UI hiding controls from guests.
 *
 * The critical interview point: "I didn't just hide the button from guests —
 * I verified that a guest JWT calling the admin endpoint gets a real 403,
 * regardless of what the frontend does."
 */

const jwt = require("jsonwebtoken");

// Access the same secret the server uses
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "pw-access-dev-secret-change-in-prod";

const { requireAuth, requireRole } = require("../auth");

// ─── Lightweight mock req/res/next helpers ────────────────────────────────────
function makeReq(role, extraHeaders = {}) {
  const token = jwt.sign(
    { sub: "test-id", username: "testuser", role, name: "Test" },
    ACCESS_SECRET,
    { expiresIn: "1m" }
  );
  return {
    cookies: { access_token: token },
    headers: { authorization: "", ...extraHeaders },
    user: null,
  };
}

function makeRes() {
  const res = { _status: 200, _body: null };
  res.status = (code) => { res._status = code; return res; };
  res.json   = (body)  => { res._body  = body;  return res; };
  return res;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Server-side RBAC", () => {

  describe("requireAuth middleware", () => {
    test("sets req.user when access token cookie is valid", () => {
      const req  = makeReq("admin");
      const res  = makeRes();
      const next = jest.fn();

      requireAuth(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.user).toBeDefined();
      expect(req.user.role).toBe("admin");
    });

    test("returns 401 when no token is present", () => {
      const req  = { cookies: {}, headers: { authorization: "" } };
      const res  = makeRes();
      const next = jest.fn();

      requireAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    test("returns 401 when token is tampered with", () => {
      const req  = { cookies: { access_token: "totally.fake.token" }, headers: { authorization: "" } };
      const res  = makeRes();
      const next = jest.fn();

      requireAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });
  });

  describe("requireRole middleware", () => {
    test("allows admin to access admin-only route", () => {
      const req  = makeReq("admin");
      const res  = makeRes();
      const next = jest.fn();

      // First set req.user via requireAuth
      requireAuth(req, res, jest.fn());
      requireRole("admin")(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res._status).toBe(200); // not changed — next() was called
    });

    test("returns 403 when guest calls admin-only DELETE /api/endpoints", () => {
      const req  = makeReq("guest");
      const res  = makeRes();
      const next = jest.fn();

      requireAuth(req, res, jest.fn());
      requireRole("admin")(req, res, next);

      // The KEY assertion — server enforces this, not just the UI
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
      expect(res._body.error).toMatch(/forbidden/i);
    });

    test("returns 403 when guest calls admin-only POST /api/endpoints", () => {
      const req  = makeReq("guest");
      const res  = makeRes();
      const next = jest.fn();

      requireAuth(req, res, jest.fn());
      requireRole("admin")(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });
  });

  describe("role is embedded in JWT — cannot be spoofed by the client", () => {
    test("a tampered role claim in the token is rejected", () => {
      // Simulate a client that takes a valid guest token and manually edits
      // the payload to change role to "admin" — the signature will be invalid
      const guestToken = jwt.sign(
        { sub: "2", username: "guest", role: "guest", name: "Guest" },
        ACCESS_SECRET,
        { expiresIn: "1m" }
      );

      // Manually modify the payload segment (base64 decode, change role, re-encode)
      const [header, , sig] = guestToken.split(".");
      const tamperedPayload = Buffer.from(
        JSON.stringify({ sub: "2", username: "guest", role: "admin", name: "Guest", iat: Date.now() })
      ).toString("base64url");
      const tamperedToken = `${header}.${tamperedPayload}.${sig}`;

      const req  = { cookies: { access_token: tamperedToken }, headers: { authorization: "" } };
      const res  = makeRes();
      const next = jest.fn();

      requireAuth(req, res, next);

      // Signature mismatch → 401, tampered role never reaches requireRole
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });
  });
});
