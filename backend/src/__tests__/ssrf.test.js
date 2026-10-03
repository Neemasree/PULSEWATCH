/**
 * ssrf.test.js
 * Unit tests for the SSRF validation engine.
 */

const { isPrivateIp, isPrivateIpv4, isPrivateIpv6, validateUrlSafety } = require("../ssrf");

describe("SSRF Protection", () => {
  describe("isPrivateIpv4", () => {
    test("detects 127.0.0.0/8 loopback", () => {
      expect(isPrivateIpv4("127.0.0.1")).toBe(true);
      expect(isPrivateIpv4("127.255.255.254")).toBe(true);
    });

    test("detects 10.0.0.0/8 private network", () => {
      expect(isPrivateIpv4("10.0.0.1")).toBe(true);
      expect(isPrivateIpv4("10.254.1.1")).toBe(true);
    });

    test("detects 172.16.0.0/12 private network", () => {
      expect(isPrivateIpv4("172.16.0.1")).toBe(true);
      expect(isPrivateIpv4("172.31.255.255")).toBe(true);
      expect(isPrivateIpv4("172.32.0.1")).toBe(false);
    });

    test("detects 192.168.0.0/16 private network", () => {
      expect(isPrivateIpv4("192.168.1.1")).toBe(true);
      expect(isPrivateIpv4("192.168.254.254")).toBe(true);
    });

    test("detects 169.254.0.0/16 link-local and cloud metadata", () => {
      expect(isPrivateIpv4("169.254.169.254")).toBe(true);
      expect(isPrivateIpv4("169.254.1.1")).toBe(true);
    });

    test("detects 0.0.0.0/8 and multicast/reserved", () => {
      expect(isPrivateIpv4("0.0.0.0")).toBe(true);
      expect(isPrivateIpv4("224.0.0.1")).toBe(true);
      expect(isPrivateIpv4("240.0.0.1")).toBe(true);
    });

    test("allows public IPv4 addresses", () => {
      expect(isPrivateIpv4("8.8.8.8")).toBe(false);
      expect(isPrivateIpv4("1.1.1.1")).toBe(false);
      expect(isPrivateIpv4("142.250.190.46")).toBe(false);
    });
  });

  describe("isPrivateIpv6", () => {
    test("detects IPv6 loopback", () => {
      expect(isPrivateIpv6("::1")).toBe(true);
      expect(isPrivateIpv6("0:0:0:0:0:0:0:1")).toBe(true);
    });

    test("detects IPv6 unique local (fc00::/7)", () => {
      expect(isPrivateIpv6("fc00::1")).toBe(true);
      expect(isPrivateIpv6("fd12:3456:789a::1")).toBe(true);
    });

    test("detects IPv6 link-local (fe80::/10)", () => {
      expect(isPrivateIpv6("fe80::1")).toBe(true);
    });

    test("detects IPv4-mapped IPv6 pointing to private addresses", () => {
      expect(isPrivateIpv6("::ffff:127.0.0.1")).toBe(true);
      expect(isPrivateIpv6("::ffff:192.168.1.1")).toBe(true);
      expect(isPrivateIpv6("::ffff:8.8.8.8")).toBe(false);
    });
  });

  describe("validateUrlSafety", () => {
    test("rejects non-http/https schemes", async () => {
      await expect(validateUrlSafety("ftp://example.com")).rejects.toThrow(
        /Only HTTP and HTTPS protocols are allowed/
      );
      await expect(validateUrlSafety("file:///etc/passwd")).rejects.toThrow(
        /Only HTTP and HTTPS protocols are allowed/
      );
      await expect(validateUrlSafety("gopher://127.0.0.1")).rejects.toThrow(
        /Only HTTP and HTTPS protocols are allowed/
      );
    });

    test("rejects localhost by hostname", async () => {
      await expect(validateUrlSafety("http://localhost:3000")).rejects.toThrow(
        /Access to local addresses is prohibited/
      );
      await expect(validateUrlSafety("http://my.localhost")).rejects.toThrow(
        /Access to local addresses is prohibited/
      );
      await expect(validateUrlSafety("http://0.0.0.0")).rejects.toThrow(
        /Access to local addresses is prohibited/
      );
    });

    test("rejects private IP literals directly", async () => {
      await expect(validateUrlSafety("http://127.0.0.1")).rejects.toThrow(
        /Access to private\/internal IP addresses is prohibited/
      );
      await expect(validateUrlSafety("http://10.0.0.5:8080")).rejects.toThrow(
        /Access to private\/internal IP addresses is prohibited/
      );
      await expect(validateUrlSafety("http://192.168.1.254")).rejects.toThrow(
        /Access to private\/internal IP addresses is prohibited/
      );
      await expect(validateUrlSafety("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
        /Access to private\/internal IP addresses is prohibited/
      );
    });

    test("accepts valid public URLs", async () => {
      const parsed = await validateUrlSafety("https://www.google.com");
      expect(parsed.hostname).toBe("www.google.com");
      expect(parsed.protocol).toBe("https:");
    });
  });
});
