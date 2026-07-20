/**
 * alerter.js
 * Sends anomaly alerts to a Slack incoming webhook.
 * The webhook URL is kept in an environment variable so it's never
 * committed to source control and can differ per environment.
 */

const axios = require("axios");

// Simple in-memory cooldown map: url → last alert timestamp (ms)
// Prevents flooding Slack when a URL stays anomalous for many consecutive checks.
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between alerts per URL
const lastAlertTimes = new Map();

/**
 * Sends a Slack notification for an anomalous ping result.
 * Silently no-ops if SLACK_WEBHOOK_URL is not configured.
 *
 * @param {object} result     The ping result (from pinger.js)
 * @param {object} anomaly    The anomaly info (from anomaly.js detectAnomaly)
 */
async function sendSlackAlert(result, anomaly) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return; // Not configured — skip silently

  // Cooldown check — don't spam the channel
  const lastAlert = lastAlertTimes.get(result.url) || 0;
  if (Date.now() - lastAlert < ALERT_COOLDOWN_MS) return;

  lastAlertTimes.set(result.url, Date.now());

  const message = {
    text: `:rotating_light: *PulseWatch Anomaly Detected*`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:rotating_light: *Anomaly Detected on ${result.url}*`,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*URL:*\n${result.url}` },
          { type: "mrkdwn", text: `*Status:*\n${result.status.toUpperCase()}` },
          { type: "mrkdwn", text: `*Latency:*\n${result.responseTime}ms` },
          { type: "mrkdwn", text: `*Z-Score:*\n${anomaly.zScore}` },
          { type: "mrkdwn", text: `*Baseline Mean:*\n${anomaly.mean}ms` },
          { type: "mrkdwn", text: `*Std Dev:*\n${anomaly.stdDev}ms` },
          { type: "mrkdwn", text: `*Time:*\n${result.timestamp}` },
        ],
      },
    ],
  };

  try {
    await axios.post(webhookUrl, message, { timeout: 5000 });
    console.log(`[Alert] Slack notification sent for ${result.url}`);
  } catch (err) {
    // Don't let a failed alert crash the monitoring loop
    console.error(`[Alert] Failed to send Slack alert: ${err.message}`);
  }
}

module.exports = { sendSlackAlert };
