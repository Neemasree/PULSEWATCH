/**
 * ssrf.js
 * SSRF protection: validates that URLs are safe to ping.
 *
 * Checks:
 *   1. Scheme must be http: or https:
 *   2. Hostname is not localhost or IP literal in a private/restricted range
 *   3. DNS resolution does not point to a loopback, private, or link-local IP
 */

const dns = require("dns");
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
  // IANA special-purpose, documentation, benchmarking and deprecated relay ranges.
  if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return true;
  if (a === 192 && b === 88 && parts[2] === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
  if (a >= 224) return true;

  return false;
}

function ipv6ToBigInt(ip) {
  let address = String(ip).toLowerCase().split("%")[0];
  if (address.includes(".")) {
    const splitAt = address.lastIndexOf(":");
    const ipv4 = address.slice(splitAt + 1);
    if (!net.isIPv4(ipv4)) return null;
    const octets = ipv4.split(".").map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    address = `${address.slice(0, splitAt)}:${high}:${low}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = halves.length === 2
    ? [...left, ...Array(missing).fill("0"), ...right]
    : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6HasPrefix(address, prefix, bits) {
  return (address >> BigInt(128 - bits)) === BigInt(prefix);
}

function isPrivateIpv6(ip) {
  const address = ipv6ToBigInt(ip);
  // Invalid addresses are unsafe. Only globally-routable unicast IPv6 is
  // accepted below; this also blocks reserved and transition address space.
  if (address === null) return true;

  if (address === 0n || address === 1n) return true; // unspecified / loopback

  // IPv4-mapped IPv6 (::ffff:0:0/96), including fully expanded notation.
  if ((address >> 32n) === 0xffffn) {
    const v4 = Number(address & 0xffffffffn);
    const mapped = [
      (v4 >>> 24) & 255,
      (v4 >>> 16) & 255,
      (v4 >>> 8) & 255,
      v4 & 255,
    ].join(".");
    return isPrivateIpv4(mapped);
  }

  // Deprecated IPv4-compatible form and other ::/96 special addresses.
  if ((address >> 32n) === 0n) return true;
  if (ipv6HasPrefix(address, 0xff, 8)) return true; // multicast
  if (ipv6HasPrefix(address, 0xfc, 7)) return true; // unique-local
  if (ipv6HasPrefix(address, 0x3fa, 10)) return true; // link-local fe80::/10

  // Global unicast allocation is 2000::/3. Reject all other address classes,
  // including NAT64, discard-only, site-local and reserved ranges.
  if (!ipv6HasPrefix(address, 0x2000, 3)) return true;

  // Special-purpose ranges inside global-unicast space, including IETF
  // protocol assignments, documentation, benchmarking, Teredo and 6to4.
  if (ipv6HasPrefix(address, 0x2001, 23)) return true; // 2001::/23
  if (ipv6HasPrefix(address, 0x20010db8, 32)) return true; // documentation
  if (ipv6HasPrefix(address, 0x20020000, 16)) return true; // 6to4
  if (ipv6HasPrefix(address, 0x3fff0000, 20)) return true; // documentation

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

  if (parsed.username || parsed.password) {
    throw new Error("URL credentials are not allowed");
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
    const records = await dns.promises.lookup(cleanHost, { all: true });
    // A successful lookup with no addresses is not a safe destination.
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error(`Hostname could not be resolved: ${cleanHost}`);
    }
    for (const record of records) {
      if (!record || !record.address || isPrivateIp(record.address)) {
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

/**
 * Node http(s) Agent lookup callback. Validation is repeated at connection
 * time to prevent DNS rebinding after a URL was saved.
 */
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const records = Array.isArray(addresses) ? addresses : (addresses ? [addresses] : []);
    if (records.length === 0 || records.some((record) => !record || !record.address)) {
      const error = new Error(`Hostname resolved to no usable addresses (${hostname})`);
      error.code = "ERR_DNS_EMPTY_RESULT";
      return callback(error);
    }
    const unsafe = records.find((record) => isPrivateIp(record.address));
    if (unsafe) {
      const error = new Error(`Hostname resolved to private IP (${unsafe.address})`);
      error.code = "ERR_SSRF_PRIVATE_IP";
      return callback(error);
    }
    if (options.all) return callback(null, records);
    return callback(null, records[0].address, records[0].family);
  });
}

module.exports = {
  isPrivateIpv4,
  isPrivateIpv6,
  isPrivateIp,
  validateUrlSafety,
  safeLookup,
};
