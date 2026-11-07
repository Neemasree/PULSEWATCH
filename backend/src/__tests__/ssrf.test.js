/**
 * ssrf.test.js
 * Unit tests for the SSRF validation engine.
 */

const dns = require("dns");
const { isPrivateIp, isPrivateIpv4, isPrivateIpv6, validateUrlSafety, safeLookup } = require("../ssrf");

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

    test("blocks documentation and benchmarking IPv4 ranges", () => {
      for (const ip of ["192.0.0.1", "192.0.2.1", "198.51.100.10", "203.0.113.8", "198.18.0.1", "198.19.255.254", "192.88.99.1"]) {
        expect(isPrivateIpv4(ip)).toBe(true);
      }
      expect(isPrivateIpv4("192.0.1.1")).toBe(false);
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

    test("detects hexadecimal IPv4-mapped private addresses", () => {
      expect(isPrivateIpv6("::ffff:7f00:1")).toBe(true); // 127.0.0.1
      expect(isPrivateIpv6("::ffff:a00:1")).toBe(true); // 10.0.0.1
      expect(isPrivateIpv6("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254
      expect(isPrivateIpv6("::ffff:808:808")).toBe(false); // 8.8.8.8
    });

    test("blocks IPv6 multicast destinations", () => {
      expect(isPrivateIpv6("ff02::1")).toBe(true);
    });

    test("detects the full IPv6 link-local range and expanded IPv4-mapped notation", () => {
      expect(isPrivateIpv6("fe81::1")).toBe(true);
      expect(isPrivateIpv6("febf::1")).toBe(true);
      expect(isPrivateIpv6("0:0:0:0:0:ffff:7f00:1")).toBe(true);
    });

    test("blocks non-global, transition, and documentation IPv6 ranges", () => {
      for (const ip of [
        "::",
        "::8.8.8.8",
        "64:ff9b::7f00:1",
        "2001:0::1",
        "2001:db8::1",
        "2002:7f00:1::1",
        "3fff::1",
        "4000::1",
      ]) {
        expect(isPrivateIpv6(ip)).toBe(true);
      }
    });

    test("allows assigned public global-unicast IPv6 addresses", () => {
      expect(isPrivateIpv6("2606:4700:4700::1111")).toBe(false);
      expect(isPrivateIpv6("2001:4860:4860::8888")).toBe(false);
    });
  });

  describe("validateUrlSafety", () => {
    test("rejects URLs containing embedded credentials", async () => {
      await expect(validateUrlSafety("https://user:secret@example.com"))
        .rejects.toThrow(/URL credentials are not allowed/);
    });

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

    test("fails closed when DNS returns an empty address list", async () => {
      const lookup = jest.spyOn(dns.promises, "lookup").mockResolvedValue([]);
      try {
        await expect(validateUrlSafety("https://empty-dns.example")).rejects.toThrow(
          /Hostname could not be resolved/
        );
      } finally {
        lookup.mockRestore();
      }
    });

    test("accepts valid public URLs", async () => {
      const parsed = await validateUrlSafety("https://www.google.com");
      expect(parsed.hostname).toBe("www.google.com");
      expect(parsed.protocol).toBe("https:");
    });
  });

  describe("safeLookup", () => {
    test("rejects an empty DNS result instead of dereferencing an absent address", (done) => {
      const lookup = jest.spyOn(dns, "lookup").mockImplementation((_hostname, _options, callback) => {
        callback(null, []);
      });
      safeLookup("empty-dns.example", {}, (error) => {
        expect(error).toBeTruthy();
        expect(error.code).toBe("ERR_DNS_EMPTY_RESULT");
        lookup.mockRestore();
        done();
      });
    });
  });
});
