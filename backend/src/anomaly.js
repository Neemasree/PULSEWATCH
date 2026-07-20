/**
 * anomaly.js
 * Z-score based anomaly detection for latency readings.
 *
 * A z-score measures how many standard deviations a value is from the mean.
 * Formula: z = (value - mean) / stdDev
 *
 * Threshold = 3 because in a normal distribution, 99.7% of values fall within
 * ±3 standard deviations. A z-score > 3 means the value is extremely unusual —
 * a strong signal of a real problem rather than random noise.
 */

const MIN_READINGS = 10; // don't flag anomalies until we have enough history
const Z_THRESHOLD = 3;

/**
 * Calculates mean and standard deviation for an array of numbers.
 * @param {number[]} values
 * @returns {{ mean: number, stdDev: number }}
 */
function calcStats(values) {
  const n = values.length;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;

  // Population standard deviation (we have the full sample window, not a subset)
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);

  return { mean, stdDev };
}

/**
 * Decides whether a new latency reading is anomalous given recent history.
 *
 * Edge case: if we have fewer than MIN_READINGS, we skip detection entirely.
 * This prevents false alarms on startup when there's not enough data to
 * establish a meaningful baseline.
 *
 * @param {number[]} readings  Array of recent response times (ms), oldest first
 * @param {number}   newValue  The new response time to evaluate
 * @returns {{ isAnomaly: boolean, zScore: number | null, mean: number | null, stdDev: number | null }}
 */
function detectAnomaly(readings, newValue) {
  // Not enough data yet — return a neutral result
  if (readings.length < MIN_READINGS) {
    return {
      isAnomaly: false,
      zScore: null,
      mean: null,
      stdDev: null,
      reason: "insufficient_data",
    };
  }

  const { mean, stdDev } = calcStats(readings);

  // If stdDev is 0 (all values identical), any deviation is technically infinite.
  // Treat it as non-anomalous — the service is rock-steady.
  if (stdDev === 0) {
    return {
      isAnomaly: newValue !== mean,
      zScore: newValue !== mean ? Infinity : 0,
      mean,
      stdDev,
    };
  }

  const zScore = (newValue - mean) / stdDev;

  return {
    isAnomaly: Math.abs(zScore) > Z_THRESHOLD,
    zScore: parseFloat(zScore.toFixed(3)),
    mean: parseFloat(mean.toFixed(2)),
    stdDev: parseFloat(stdDev.toFixed(2)),
  };
}

module.exports = { detectAnomaly, calcStats, MIN_READINGS, Z_THRESHOLD };
