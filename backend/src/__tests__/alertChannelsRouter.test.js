require("dotenv").config();

const request = require("supertest");
const jwt = require("jsonwebtoken");
const { app } = require("../index");
const { ACCESS_SECRET } = require("../auth");

function authenticatedRequest() {
  const csrf = "csrf-alert-channel-validation";
  const token = jwt.sign(
    { sub: "987654321", username: "route-validation-test", role: "guest", name: "Route Validation" },
    ACCESS_SECRET,
    { expiresIn: "5m" }
  );
  return (method, path) => {
    let req = request(app)[method](path)
      .set("Cookie", `access_token=${token}; csrf_token=${csrf}`);
    if (["post", "patch", "delete"].includes(method)) req = req.set("x-csrf-token", csrf);
    return req;
  };
}

describe("alert channel route ID validation", () => {
  const send = authenticatedRequest();

  test.each([
    ["POST", "/api/alert-channels/not-a-number/test", "post"],
    ["POST", "/api/alert-channels/12oops/test", "post"],
    ["POST", "/api/alert-channels/0/test", "post"],
    ["POST", "/api/alert-channels/-1/test", "post"],
    ["POST", "/api/alert-channels/9007199254740992/test", "post"],
    ["PATCH", "/api/alert-channels/12oops", "patch"],
    ["PATCH", "/api/alert-channels/0", "patch"],
    ["GET", "/api/alert-channels/12oops/deliveries", "get"],
    ["GET", "/api/alert-channels/9007199254740992/deliveries", "get"],
    ["DELETE", "/api/alert-channels/12oops", "delete"],
    ["DELETE", "/api/alert-channels/-1", "delete"],
  ])("%s %s rejects malformed IDs before database access", async (_method, path, method) => {
    const response = await send(method, path);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/channel id/i);
  });
});
