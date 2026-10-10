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
      method: options.method || "GET",
      headers: options.headers || undefined,
      data: options.body || undefined,
      timeout: options.timeoutMs || 5000,
      maxRedirects: 3,
      httpAgent: new http.Agent({ lookup: safeLookup }),
      httpsAgent: new https.Agent({ lookup: safeLookup }),
      // Don't throw on 4xx/5xx so we can report them as "down" with detail
      validateStatus: () => true,
    };
    if (options.keyword) {
      requestOptions.responseType = "text";
      requestOptions.maxContentLength = 1024 * 1024;
      requestOptions.maxBodyLength = 1024 * 1024;
    }
    const response = await axios.request({ url, ...requestOptions });

    const responseTime = Date.now() - start;
    const body = typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? "");
    const keywordMatched = !options.keyword ||
      (options.keywordMode === "absent" ? !body.includes(options.keyword) : body.includes(options.keyword));

    return {
      url,
      status: isUp ? "up" : "down",
      httpStatus: response.status,
      responseTime,
      timestamp: new Date().toISOString(),
      body: options.keyword ? body : undefined,
      failureReason: keywordMatched ? undefined : "keyword",
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
      error: err.code || err.message,
      failureReason: err.code === "ETIMEDOUT" || err.code === "ECONNABORTED"
        ? "timeout"
        : err.code === "ENOTFOUND" ? "dns" : "connection",
    };
  }
}

module.exports = { pingUrl };
