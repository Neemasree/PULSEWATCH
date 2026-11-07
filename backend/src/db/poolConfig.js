function getDatabaseSslConfig(databaseUrl, databaseSsl, rejectUnauthorizedOverride, pgHost) {
  if (databaseSsl === "false") return false;
  let hostname = "";
  if (databaseUrl) {
    try {
      hostname = new URL(databaseUrl).hostname.toLowerCase();
    } catch {
      // Let pg handle malformed connection strings; do not silently disable TLS.
      return { rejectUnauthorized: rejectUnauthorizedOverride !== "false" };
    }
  } else if (typeof pgHost === "string") {
    hostname = pgHost.toLowerCase().replace(/^\\[|\\]$/g, "");
  } else {
    return false;
  }

  const isLocalDatabase = hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]";
  if (isLocalDatabase) return false;

  return {
    rejectUnauthorized: rejectUnauthorizedOverride !== "false",
  };
}

module.exports = { getDatabaseSslConfig };
