const tls = require("tls");
const { safeLookup } = require("./ssrf");

function inspectCertificate(urlString, timeoutMs = 5000) {
  const url = new URL(urlString);
  if (url.protocol !== "https:") return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: url.hostname,
      port: Number(url.port) || 443,
      servername: url.hostname,
      lookup: safeLookup,
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });
    const finish = (error, value) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.once("secureConnect", () => {
      const validTo = socket.getPeerCertificate()?.valid_to;
      const expiresAt = validTo ? new Date(validTo) : null;
      if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
        return finish(new Error("TLS certificate expiry is unavailable"));
      }
      finish(null, {
        sslExpiresAt: expiresAt.toISOString(),
        sslDaysLeft: Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86400000)),
      });
    });
    socket.once("timeout", () => finish(Object.assign(new Error("TLS certificate check timed out"), { code: "ETIMEDOUT" })));
    socket.once("error", (error) => finish(error));
  });
}

module.exports = { inspectCertificate };
