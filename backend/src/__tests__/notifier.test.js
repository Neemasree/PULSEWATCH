jest.mock("axios", () => ({ post: jest.fn() }));
jest.mock("../redisClient", () => ({
  client: {
    lpush: jest.fn().mockResolvedValue(1),
    ltrim: jest.fn().mockResolvedValue("OK"),
  },
}));
jest.mock("../db/alertChannels", () => ({ getChannel: jest.fn() }));
jest.mock("../ssrf", () => ({
  validateUrlSafety: jest.fn().mockResolvedValue(new URL("https://hooks.example.com")),
  safeLookup: jest.fn(),
}));

const axios = require("axios");
const { client } = require("../redisClient");
const { validateUrlSafety, safeLookup } = require("../ssrf");
const { deliver } = require("../notifier");

describe("webhook delivery hardening", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.post.mockResolvedValue({ status: 204 });
  });

  test("validates the destination and disables unvalidated redirects", async () => {
    const channel = {
      id: 41,
      type: "webhook",
      target_url: "https://hooks.example.com/ingest",
    };
    const monitor = { id: 7, name: "Checkout API", url: "https://shop.example.com" };

    const result = await deliver(channel, "down", monitor, { status: "down" });

    expect(result.status).toBe("delivered");
    expect(validateUrlSafety).toHaveBeenCalledWith(channel.target_url);
    const options = axios.post.mock.calls[0][2];
    expect(options.maxRedirects).toBe(0);
    expect(options.timeout).toBe(5000);
    expect(options.maxBodyLength).toBe(1024 * 1024);
    expect(options.maxContentLength).toBe(1024 * 1024);
    expect(options.httpsAgent.options.lookup).toBe(safeLookup);
    expect(client.lpush).toHaveBeenCalled();
    expect(client.ltrim).toHaveBeenCalledWith("alert-deliveries:41", 0, 49);
  });

  test("stores a stable error code instead of raw request details", async () => {
    const secretUrl = "https://hooks.example.com/path?token=do-not-store";
    axios.post.mockRejectedValueOnce(Object.assign(new Error(secretUrl), { code: "ECONNRESET" }))
      .mockRejectedValueOnce(Object.assign(new Error(secretUrl), { code: "ECONNRESET" }))
      .mockRejectedValueOnce(Object.assign(new Error(secretUrl), { code: "ECONNRESET" }));

    const result = await deliver(
      { id: 42, type: "webhook", target_url: secretUrl },
      "down",
      { id: 7, name: "Checkout API", url: "https://shop.example.com" },
      null
    );

    expect(result.status).toBe("failed");
    expect(result.error).toBe("ECONNRESET");
    expect(JSON.stringify(result)).not.toContain("do-not-store");
  });
});
