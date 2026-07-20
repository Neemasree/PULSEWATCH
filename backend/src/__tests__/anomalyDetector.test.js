/**
 * anomalyDetector.test.js
 * Unit tests for the detectAnomaly pure function.
 *
 * These tests are valuable to mention in interviews:
 *   "I wrote tests for the anomaly detector because it's the core
 *    statistical logic — I wanted to verify the edge cases (not enough
 *    data, flat baseline, confirmed spike) before wiring it into the
 *    live polling loop."
 */

const { detectAnomaly, MIN_READINGS, Z_THRESHOLD } = require("../anomalyDetector");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generates an array of `n` readings all equal to `value` */
const flatReadings = (value, n) => Array(n).fill(value);

/** Generates `n` readings uniformly spread around a mean */
const stableReadings = (mean = 100, spread = 10, n = 20) =>
  Array.from({ length: n }, (_, i) => mean + ((i % (spread * 2)) - spread));

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("detectAnomaly", () => {

  // ── Case 1: Insufficient data ──────────────────────────────────────────────

  describe("when there are fewer than MIN_READINGS readings", () => {
    test("returns isAnomaly=false regardless of how extreme the new value is", () => {
      const readings = [100, 110, 90]; // only 3 readings — well below MIN_READINGS
      const result = detectAnomaly(readings, 999999); // extreme spike

      expect(result.isAnomaly).toBe(false);
      expect(result.zScore).toBeNull();
      expect(result.mean).toBeNull();
      expect(result.reason).toBe("insufficient_data");
    });

    test("returns isAnomaly=false with exactly MIN_READINGS - 1 entries", () => {
      const readings = flatReadings(100, MIN_READINGS - 1);
      const result = detectAnomaly(readings, 50000);

      expect(result.isAnomaly).toBe(false);
    });

    test("returns isAnomaly=false with an empty array", () => {
      const result = detectAnomaly([], 500);
      expect(result.isAnomaly).toBe(false);
    });

    test("returns isAnomaly=false with null/undefined readings", () => {
      expect(detectAnomaly(null, 500).isAnomaly).toBe(false);
      expect(detectAnomaly(undefined, 500).isAnomaly).toBe(false);
    });
  });

  // ── Case 2: Normal readings, normal new value ──────────────────────────────

  describe("when readings are stable and the new value is typical", () => {
    test("returns isAnomaly=false for a value within normal range", () => {
      // 20 readings clustered tightly around 200ms
      const readings = stableReadings(200, 15, 20);
      const result = detectAnomaly(readings, 205); // well within 3σ

      expect(result.isAnomaly).toBe(false);
      expect(typeof result.zScore).toBe("number");
      expect(Math.abs(result.zScore)).toBeLessThanOrEqual(Z_THRESHOLD);
    });

    test("returns sensible mean and stdDev values", () => {
      // stableReadings(100, 10, 20) generates values: 90,91,...,109
      // actual mean = (90+91+...+109)/20 = 1990/20 = 99.5
      const readings = stableReadings(100, 10, 20);
      const result = detectAnomaly(readings, 99.5);

      // mean should be very close to 99.5 (the centre of our range)
      expect(result.mean).toBeCloseTo(99.5, 1);
      expect(result.stdDev).toBeGreaterThan(0);
      expect(result.isAnomaly).toBe(false);
    });
  });

  // ── Case 3: Normal readings, anomalous spike ───────────────────────────────

  describe("when readings are stable and the new value is a large spike", () => {
    test("returns isAnomaly=true for a value far above the mean", () => {
      // Tight cluster around 100ms, standard deviation will be ~5ms
      const readings = Array.from({ length: 20 }, (_, i) => 95 + (i % 10));
      const result = detectAnomaly(readings, 500); // 500ms vs ~100ms mean

      expect(result.isAnomaly).toBe(true);
      expect(result.zScore).toBeGreaterThan(Z_THRESHOLD);
    });

    test("returns isAnomaly=true for a value far below the mean (negative z-score)", () => {
      // Mean ~500ms, new value is near-zero — also anomalous (negative spike)
      const readings = Array.from({ length: 20 }, (_, i) => 490 + (i % 20));
      const result = detectAnomaly(readings, 1); // 1ms vs ~500ms mean

      expect(result.isAnomaly).toBe(true);
      expect(result.zScore).toBeLessThan(-Z_THRESHOLD);
    });

    test("zScore magnitude increases with the size of the spike", () => {
      const readings = stableReadings(100, 5, 20);

      const mild   = detectAnomaly(readings, 150);
      const severe = detectAnomaly(readings, 500);

      // A bigger spike should produce a larger z-score magnitude
      expect(Math.abs(severe.zScore)).toBeGreaterThan(Math.abs(mild.zScore));
    });
  });

  // ── Case 4: Edge case — perfectly flat baseline ────────────────────────────

  describe("when all readings are identical (stdDev = 0)", () => {
    test("marks any different value as anomalous", () => {
      const readings = flatReadings(100, 15);
      const result = detectAnomaly(readings, 101); // even a tiny deviation

      expect(result.isAnomaly).toBe(true);
      expect(result.zScore).toBe(Infinity);
    });

    test("marks the same value as NOT anomalous", () => {
      const readings = flatReadings(100, 15);
      const result = detectAnomaly(readings, 100);

      expect(result.isAnomaly).toBe(false);
      expect(result.zScore).toBe(0);
    });
  });

  // ── Case 5: Boundary — exactly at the threshold ────────────────────────────

  describe("z-score threshold boundary", () => {
    test("is NOT anomalous when z-score equals exactly Z_THRESHOLD", () => {
      // Construct a reading whose z-score is exactly 3.0
      // mean=100, stdDev=10 → value = 100 + 3×10 = 130 → z = exactly 3.0
      const mean   = 100;
      const stdDev = 10;
      const n      = MIN_READINGS;
      // Build readings that produce mean=100, stdDev=10
      // Use ±10 alternating values around the mean
      const readings = Array.from({ length: n }, (_, i) =>
        i % 2 === 0 ? mean + stdDev : mean - stdDev
      );
      const valueAtThreshold = mean + Z_THRESHOLD * stdDev; // 130

      const result = detectAnomaly(readings, valueAtThreshold);
      // z = exactly 3.0 — condition is > 3, so this should NOT be flagged
      expect(result.isAnomaly).toBe(false);
    });

    test("IS anomalous when z-score is just above Z_THRESHOLD", () => {
      const mean   = 100;
      const stdDev = 10;
      const n      = MIN_READINGS;
      const readings = Array.from({ length: n }, (_, i) =>
        i % 2 === 0 ? mean + stdDev : mean - stdDev
      );
      const valueJustOver = mean + Z_THRESHOLD * stdDev + 0.1; // 130.1

      const result = detectAnomaly(readings, valueJustOver);
      expect(result.isAnomaly).toBe(true);
    });
  });

  // ── Case 6: Output shape ───────────────────────────────────────────────────

  describe("return value shape", () => {
    test("always returns an object with isAnomaly, zScore, mean, stdDev", () => {
      const normalResult = detectAnomaly(stableReadings(100, 5, 20), 100);
      expect(normalResult).toHaveProperty("isAnomaly");
      expect(normalResult).toHaveProperty("zScore");
      expect(normalResult).toHaveProperty("mean");
      expect(normalResult).toHaveProperty("stdDev");

      const insufficientResult = detectAnomaly([], 100);
      expect(insufficientResult).toHaveProperty("isAnomaly");
      expect(insufficientResult).toHaveProperty("zScore");
    });
  });
});
