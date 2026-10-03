/**
 * ssrf.js
 * SSRF protection: validates that URLs are safe to ping.
 *
 * Checks:
 *   1. Scheme must be http: or https:
 *   2. Hostname is not localhost or IP literal in a private/restricted range
 *   3. DNS resolution does not point to a loopback, private, or link-local IP
 */

const dns = require("dns").promises;
const net = require("net");

function isPrivateIpv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return true;

  const [a, b] = parts;
  // 0.0.0.0/8
  if (a === 0) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 10.0.0.0/8 (Private)
  if (a === 10) return true;
  // 172.16.0.0/12 (Private)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (Private)
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (Link-local / AWS / GCP metadata)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 (Carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
  if (a >= 224) return true;

  return false;
}

function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase();
  // Loopback / unspecified
  if (normalized === "::1" || normalized === "::" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  // IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (normalized.startsWith("::ffff:")) {
    const v4Part = normalized.slice(7);
    if (net.isIPv4(v4Part)) {
      return isPrivateIpv4(v4Part);
    }
  }
  // Unique Local (fc00::/7 -> fc.. or fd..)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  // Link-local (fe80::/10)
  if (
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }

  return false;
}

function isPrivateIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return true; // Not a valid IP -> consider unsafe
}

/**
 * Validates a URL string for SSRF safety.
 * Throws an Error with a descriptive message if unsafe.
 *
 * @param {string} urlString
 * @returns {Promise<URL>}
 */
async function validateUrlSafety(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error("Invalid URL format");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS protocols are allowed");
  }

  const hostname = parsed.hostname.toLowerCase();

  // Strip brackets from IPv6 hostnames
  const cleanHost = hostname.replace(/^\[|\]$/g, "");

  // Hostname string checks
  if (
    cleanHost === "localhost" ||
    cleanHost.endsWith(".localhost") ||
    cleanHost.endsWith(".local") ||
    cleanHost === "0.0.0.0"
  ) {
    throw new Error("Access to local addresses is prohibited (SSRF protection)");
  }

  // If the host is already an IP address
  if (net.isIP(cleanHost)) {
    if (isPrivateIp(cleanHost)) {
      throw new Error("Access to private/internal IP addresses is prohibited (SSRF protection)");
    }
    return parsed;
  }

  // DNS resolution check
  try {
    const records = await dns.lookup(cleanHost, { all: true });
    for (const record of records) {
      if (isPrivateIp(record.address)) {
        throw new Error(
          `URL hostname resolves to private IP (${record.address}) - SSRF prohibited`
        );
      }
    }
  } catch (err) {
    // If DNS resolution itself fails or was rejected
    if (err.message.includes("SSRF prohibited")) {
      throw err;
    }
    // DNS resolution failure (ENOTFOUND, etc.)
    throw new Error(`Hostname could not be resolved: ${cleanHost}`);
  }

  return parsed;
}

module.exports = {
  isPrivateIpv4,
  isPrivateIpv6,
  isPrivateIp,
  validateUrlSafety,
};
