const axios = require("axios");
const { client } = require("./redisClient");
const { getChannel } = require("./db/alertChannels");
const pool = require("./db/pool");
const { validateUrlSafety } = require("./ssrf");

async function deliver(channel, event, monitor, result) {
  const payload = channel.type === "slack"
    ? { blocks: [{ type: "section", text: { type: "mrkdwn", text: `*${event}* ${monitor.name} (${monitor.url})` } }] }
    : channel.type === "discord"
      ? { content: `${event}: ${monitor.name}`, embeds: [{ title: monitor.name, url: monitor.url }] }
      : { event, monitor: { id: monitor.id, name: monitor.name, url: monitor.url }, result, timestamp: new Date().toISOString() };
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await validateUrlSafety(channel.target_url);
      const response = await axios.post(channel.target_url, payload, { timeout: 5000 });
      const delivery = { event, status: "delivered", statusCode: response.status, timestamp: new Date().toISOString() };
      await client.lpush(`alert-deliveries:${channel.id}`, JSON.stringify(delivery));
      await client.ltrim(`alert-deliveries:${channel.id}`, 0, 49);
      return delivery;
    } catch (err) {
      lastError = err;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
  const delivery = { event, status: "failed", error: lastError.message, timestamp: new Date().toISOString() };
  await client.lpush(`alert-deliveries:${channel.id}`, JSON.stringify(delivery));
  await client.ltrim(`alert-deliveries:${channel.id}`, 0, 49);
  console.error(`[Notifier] channel ${channel.id}: ${lastError.message}`);
  return delivery;
}

async function notify(monitor, event, result = null) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM alert_channels WHERE user_id = $1 AND enabled = true AND events ? $2",
      [monitor.user_id, event]
    );
    return Promise.all(rows.map((channel) => deliver(channel, event, monitor, result)));
  } catch (err) {
    console.error(`[Notifier] ${event} failed: ${err.message}`);
    return [];
  }
}

async function testChannel(id, userId, isAdmin) {
  const channel = await getChannel(id, userId, isAdmin);
  if (!channel) return null;
  return deliver(channel, "test", { id: 0, name: "PulseWatch test", url: "https://example.com" }, null);
}

module.exports = { notify, testChannel, deliver };
