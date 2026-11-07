jest.mock("axios", () => ({ post: jest.fn().mockResolvedValue({ status: 200 }) }));
jest.mock("../redisClient", () => ({ acquireCooldown: jest.fn().mockResolvedValue(true) }));
jest.mock("../ssrf", () => ({
  validateUrlSafety: jest.fn().mockResolvedValue(new URL("https://hooks.slack.com/services/test")),
  safeLookup: jest.fn(),
}));

const axios = require("axios");
const { acquireCooldown } = require("../redisClient");
const { validateUrlSafety, safeLookup } = require("../ssrf");
const { sendSlackAlert } = require("../alerts");

describe("Slack alert delivery", () => {
  const previousWebhook = process.env.SLACK_WEBHOOK_URL;
  const monitoredUrl = "https://api.example.com/health";
  const result = {
    status: "down",
    httpStatus: 503,
    responseTime: 1200,
    timestamp: "2026-11-07T10:00:00.000Z",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/test";
    validateUrlSafety.mockResolvedValue(new URL(process.env.SLACK_WEBHOOK_URL));
    acquireCooldown.mockResolvedValue(true);
    axios.post.mockResolvedValue({ status: 200 });
  });

  afterAll(() => {
    if (previousWebhook === undefined) delete process.env.SLACK_WEBHOOK_URL;
    else process.env.SLACK_WEBHOOK_URL = previousWebhook;
  });

  test("validates Slack target and uses safe agents without redirects", async () => {
    await sendSlackAlert(monitoredUrl, result, 4.2);

    expect(validateUrlSafety).toHaveBeenCalledWith(process.env.SLACK_WEBHOOK_URL);
    expect(acquireCooldown).toHaveBeenCalledWith(
      expect.stringMatching(/^pulsewatch:cooldown:anomaly:[a-f0-9]{64}$/),
      5 * 60 * 1000
    );
    const options = axios.post.mock.calls[0][2];
    expect(options.maxRedirects).toBe(0);
    expect(options.timeout).toBe(5000);
    expect(options.httpsAgent.options.lookup).toBe(safeLookup);
    expect(options.maxBodyLength).toBe(1024 * 1024);
  });

  test("honours the distributed anomaly cooldown", async () => {
    acquireCooldown.mockResolvedValue(false);
    await sendSlackAlert(monitoredUrl, result, 4.2);
    expect(axios.post).not.toHaveBeenCalled();
    expect(validateUrlSafety).not.toHaveBeenCalled();
  });

  test("down alerts rely on the poller's cooldown and still deliver", async () => {
    await sendSlackAlert(monitoredUrl, result, null);
    expect(acquireCooldown).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalled();
  });

  test("does not send when Slack webhook URL is unsafe", async () => {
    validateUrlSafety.mockRejectedValueOnce(new Error("SSRF prohibited"));
    await sendSlackAlert(monitoredUrl, result, null);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test("does nothing when no webhook is configured", async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    await sendSlackAlert(monitoredUrl, result, 4.2);
    expect(axios.post).not.toHaveBeenCalled();
    expect(acquireCooldown).not.toHaveBeenCalled();
  });
});
