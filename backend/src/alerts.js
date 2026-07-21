/**
 * alerts.js
 * Slack alerting for two distinct event types:
 *
 *   1. DOWN alert  — endpoint returned 4xx/5xx or was unreachable (zScore = null)
 *   2. Anomaly alert — endpoint is up but z-score spiked past threshold (zScore set)
 *
 * Both share the same sendSlackAlert() function; the message text and emoji
 * differ based on whether zScore is null.
 *
 * Cooldown: the anomaly alert has its own 5-min cooldown tracked here.
 * The DOWN alert cooldown is tracked separately in poller.js so the two
 * types don't interfere with each other's rate limiting.
 *
 * Why an environment variable for the webhook URL?
 *   - Keeps secrets out of source control
 *   - Different environments (local, staging, prod) can point to different channels
 *   - If the URL ever rotates, you update one env var, not the codebase
 */

const axios = require("axios");

const COOLDOWN_MS   = 5 * 60 * 1000; // 5 minutes per URL (anomaly alerts)
const lastAlertTime = new Map();      // url → timestamp of last anomaly alert

/**
 * POSTs a formatted alert to the configured Slack webhook.
 * No-ops silently if SLACK_WEBHOOK_URL is not set.
 *
 * For anomaly alerts (zScore != null): respects a 5-min per-URL cooldown.
 * For DOWN alerts   (zScore == null): cooldown is managed by the caller (poller.js).
 *
 * @param {string}      url     The monitored URL
 * @param {object}      result  Ping result from pinger.js
 * @param {number|null} zScore  Z-score if anomaly alert; null if DOWN alert
 */
async function sendSlackAlert(url, result, zScore) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return; // alerting not configured — skip silently

  const isDownAlert = zScore === null;

  // Anomaly alerts have their own cooldown tracked here.
  // DOWN alert cooldown is handled by poller.js — don't double-gate it.
  if (!isDownAlert) {
    const last = lastAlertTime.get(url) || 0;
    if (Date.now() - last < COOLDOWN_MS) return;
    lastAlertTime.set(url, Date.now());
  }

  const emoji   = isDownAlert ? ":red_circle:" : ":rotating_light:";
  const heading = isDownAlert
    ? `${emoji} *Service DOWN: ${url}*`
    : `${emoji} *Anomaly detected on ${url}*`;

  const fields = isDownAlert
    ? [
        { type: "mrkdwn", text: `*Status:*\n${result.status.toUpperCase()}` },
        { type: "mrkdwn", text: `*HTTP:*\n${result.httpStatus ?? "unreachable"}` },
        { type: "mrkdwn", text: `*Response time:*\n${result.responseTime}ms` },
        { type: "mrkdwn", text: `*Time:*\n${result.timestamp}` },
      ]
    : [
        { type: "mrkdwn", text: `*Status:*\n${result.status.toUpperCase()}` },
        { type: "mrkdwn", text: `*Latency:*\n${result.responseTime}ms` },
        { type: "mrkdwn", text: `*Z-Score:*\n${zScore}` },
        { type: "mrkdwn", text: `*Time:*\n${result.timestamp}` },
      ];

  const payload = {
    text: heading,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: heading } },
      { type: "section", fields },
    ],
  };

  try {
    await axios.post(webhookUrl, payload, { timeout: 5000 });
    console.log(`[Alert] Slack alert sent for ${url} (${isDownAlert ? "DOWN" : `z=${zScore}`})`);
  } catch (err) {
    // A failed alert must never crash the monitoring loop
    console.error(`[Alert] Slack POST failed: ${err.message}`);
  }
}

module.exports = { sendSlackAlert };
