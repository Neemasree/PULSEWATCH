/**
 * pinger.js
 * Core HTTP ping logic. Given a URL, fires an HTTP GET and measures
 * how long it takes. Returns a structured result object.
 */

const axios = require("axios");
const http = require("http");
const https = require("https");
const { safeLookup } = require("./ssrf");

/**
 * Pings a single URL and returns a result object.
 *
 * "Down" means the server responded but with an error status (4xx/5xx).
 * "Unreachable" means we never got a response — network failure, DNS
 *   failure, or the request timed out. Both cases are reported as
 *   status: "down" to the consumer, but the error field tells you why.
 *
 * @param {string} url  The URL to check (must include protocol, e.g. https://)
 * @returns {Promise<{url, status, responseTime, timestamp, error?}>}
 */
async function pingUrl(url, options = {}) {
  const start = Date.now(); // high-res wall-clock start

  try {
    const requestOptions = {
      timeout: options.timeoutMs || 5000,
      maxRedirects: 3,
      httpAgent: new http.Agent({ lookup: safeLookup }),
      httpsAgent: new https.Agent({ lookup: safeLookup }),
      // Don't throw on 4xx/5xx so we can report them as "down" with detail
      validateStatus: () => true,
    };
    const response = await axios.get(url, requestOptions);

    const responseTime = Date.now() - start;
    const isUp = response.status >= 200 && response.status < 400;

    return {
      url,
      status: isUp ? "up" : "down",
      httpStatus: response.status,
      responseTime,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    // Network-level failure: ECONNREFUSED, ETIMEDOUT, ENOTFOUND, etc.
    const responseTime = Date.now() - start;

    return {
      url,
      status: "down",
      httpStatus: null,
      responseTime,
      timestamp: new Date().toISOString(),
      error: err.code || err.message, // e.g. "ETIMEDOUT", "ENOTFOUND"
    };
  }
}

module.exports = { pingUrl };
