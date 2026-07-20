/**
 * alerts.js  (Phase 4.4)
 * Slack alerting for anomalous ping results.
 *
 * Why an environment variable for the webhook URL?
 *   - Keeps secrets out of source control
 *   - Different environments (local, staging, prod) can each have their own
 *     channel without touching the code
 *   - If the URL ever rotates, you update one env var, not the codebase
 *
 * Cooldown: we cap alerts to one per URL per 5 minutes so a sustained
 * anomaly doesn't flood the Slack channel.
 */

const axios = require("axios");

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per URL
const lastAlertTime = new Map();    // url → timestamp of last alert sent

/**
 * POSTs a formatted anomaly alert to the configured Slack webhook.
 * No-ops silently if SLACK_WEBHOOK_URL is not set or cooldown hasn't elapsed.
 *
 * @param {string} url      The monitored URL that triggered the anomaly
 * @param {object} result   Ping result from pinger.js
 * @param {number} zScore   Z-score from detectAnomaly()
 */
async function sendSlackAlert(url, result, zScore) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return; // alerting not configured — skip silently

  const now = Date.now();
  const last = lastAlertTime.get(url) || 0;
  if (now - last < COOLDOWN_MS) return; // still in cooldown window
  lastAlertTime.set(url, now);

  const payload = {
    text: `:rotating_light: *PulseWatch Anomaly* on ${url}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:rotating_light: *Anomaly detected on ${url}*`,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Status:*\n${result.status.toUpperCase()}` },
          { type: "mrkdwn", text: `*Latency:*\n${result.responseTime}ms` },
          { type: "mrkdwn", text: `*Z-Score:*\n${zScore}` },
          { type: "mrkdwn", text: `*Time:*\n${result.timestamp}` },
        ],
      },
    ],
  };

  try {
    await axios.post(webhookUrl, payload, { timeout: 5000 });
    console.log(`[Alert] Slack alert sent for ${url} (z=${zScore})`);
  } catch (err) {
    // A failed alert must never crash the monitoring loop
    console.error(`[Alert] Slack POST failed: ${err.message}`);
  }
}

module.exports = { sendSlackAlert };
