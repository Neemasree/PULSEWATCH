function getDatabaseSslConfig(databaseUrl, databaseSsl, rejectUnauthorizedOverride) {
  if (databaseSsl === "false") return false;

  const isRemoteDatabase = Boolean(
    databaseUrl && !/(localhost|127\\.0\\.1)(?::|\\/|$)/i.test(databaseUrl)
  );
  if (!isRemoteDatabase) return false;

  return {
    rejectUnauthorized: rejectUnauthorizedOverride !== "false",
  };
}

module.exports = { getDatabaseSslConfig };
