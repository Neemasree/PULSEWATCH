/**
 * anomalyDetector.js  (Phase 4.1)
 * Pure function for z-score based latency anomaly detection.
 *
 * Written as a pure function (no imports, no side effects) so it is
 * trivial to unit-test in isolation — you can call it with any array
 * of numbers and get a deterministic result back.
 *
 * Z-score formula: z = (value − mean) / stdDev
 *
 * Why threshold = 3?
 *   In a normal distribution 99.7% of values fall within ±3 standard
 *   deviations. A z-score > 3 therefore means the new reading is in the
 *   outermost 0.3% — almost certainly a real problem, not random jitter.
 *   Using 2 would fire too often (5% false-positive rate).
 *   Using 5 would miss genuine spikes until they're enormous.
 */

const MIN_READINGS = 10; // require at least this many history points
const Z_THRESHOLD = 3;

/**
 * Determines whether a new latency reading is anomalous.
 *
 * @param {number[]} recentReadings  History of response times (ms), any order
 * @param {number}   newValue        The new response time to evaluate
 * @returns {{
 *   isAnomaly: boolean,
 *   zScore:    number | null,
 *   mean:      number | null,
 *   stdDev:    number | null,
 *   reason?:   string
 * }}
 */
function detectAnomaly(recentReadings, newValue) {
  // Edge case: not enough history to establish a baseline
  if (!recentReadings || recentReadings.length < MIN_READINGS) {
    return {
      isAnomaly: false,
      zScore: null,
      mean: null,
      stdDev: null,
      reason: "insufficient_data",
    };
  }

  // Mean
  const n = recentReadings.length;
  const mean = recentReadings.reduce((sum, v) => sum + v, 0) / n;

  // Population standard deviation
  const variance =
    recentReadings.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);

  // Edge case: perfectly flat baseline (all readings identical)
  // Any deviation is technically infinite — flag only if the value differs.
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

module.exports = { detectAnomaly, MIN_READINGS, Z_THRESHOLD };
