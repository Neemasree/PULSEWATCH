jest.mock("tls", () => ({ connect: jest.fn() }));
jest.mock("../ssrf", () => ({
  safeLookup: jest.fn(),
  validateUrlSafety: jest.fn().mockResolvedValue(new URL("https://public.example.com")),
}));

const EventEmitter = require("events");
const tls = require("tls");
const { safeLookup, validateUrlSafety } = require("../ssrf");
const { inspectCertificate } = require("../sslChecker");

function mockTlsSocket(validTo = new Date(Date.now() + 10 * 86400000).toUTCString()) {
  const socket = new EventEmitter();
  socket.destroy = jest.fn();
  socket.getPeerCertificate = jest.fn(() => ({ valid_to: validTo }));
  tls.connect.mockImplementation(() => {
    process.nextTick(() => socket.emit("secureConnect"));
    return socket;
  });
  return socket;
}

describe("SSL certificate inspection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("validates the URL before making a TLS connection and returns expiry", async () => {
    const socket = mockTlsSocket();
    const result = await inspectCertificate("https://public.example.com");

    expect(validateUrlSafety).toHaveBeenCalledWith("https://public.example.com");
    expect(tls.connect).toHaveBeenCalledWith(expect.objectContaining({
      host: "public.example.com",
      lookup: safeLookup,
      rejectUnauthorized: false,
    }));
    expect(result.sslExpiresAt).toBeTruthy();
    expect(result.sslDaysLeft).toBeGreaterThan(0);
    expect(socket.destroy).toHaveBeenCalled();
  });

  test("does not connect when destination validation rejects the URL", async () => {
    validateUrlSafety.mockRejectedValueOnce(new Error("SSRF prohibited"));

    await expect(inspectCertificate("https://internal.example.com"))
      .rejects.toThrow(/SSRF prohibited/);
    expect(tls.connect).not.toHaveBeenCalled();
  });

  test("returns null for HTTP URLs without running TLS or DNS validation", async () => {
    await expect(inspectCertificate("http://public.example.com")).resolves.toBeNull();
    expect(validateUrlSafety).not.toHaveBeenCalled();
    expect(tls.connect).not.toHaveBeenCalled();
  });

  test("rejects when the peer certificate has no valid expiry date", async () => {
    const socket = mockTlsSocket(undefined);
    socket.getPeerCertificate.mockReturnValue({});
    await expect(inspectCertificate("https://public.example.com"))
      .rejects.toThrow(/expiry is unavailable/);
    expect(socket.destroy).toHaveBeenCalled();
  });
});
