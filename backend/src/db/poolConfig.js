function getDatabaseSslConfig(databaseUrl, databaseSsl, rejectUnauthorizedOverride) {
  if (databaseSsl === "false") return false;
  if (!databaseUrl) return false;

  let hostname;
  try {
    hostname = new URL(databaseUrl).hostname.toLowerCase().replace(/^\\[|\\]$/g, "");
  } catch {
    // Let pg handle malformed connection strings; do not silently disable TLS.
    return { rejectUnauthorized: rejectUnauthorizedOverride !== "false" };
  }

  const isLocalDatabase = hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1";
  if (isLocalDatabase) return false;

  return {
    rejectUnauthorized: rejectUnauthorizedOverride !== "false",
  };
}

module.exports = { getDatabaseSslConfig };
