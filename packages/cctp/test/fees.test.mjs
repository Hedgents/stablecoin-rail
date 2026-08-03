import assert from "node:assert/strict";
import test from "node:test";
import { protocolFee, selectFeeTier } from "../dist/index.js";

// Shape recorded from https://iris-api.circle.com/v2/burn/USDC/fees/6/5 on
// 2026-08-03: minimumFee is FRACTIONAL basis points and forwardFee is numeric.
const LIVE_SHAPE = [
  { finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 270449, med: 275486, high: 302523 } },
  { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 270449, med: 275486, high: 302523 } },
];

const SCHEDULE = [
  {
    finalityThreshold: 2000,
    minimumFee: 0,
    forwardFee: { low: "800000", med: "900000", high: "1000000" },
  },
  {
    finalityThreshold: 1000,
    minimumFee: 1,
    forwardFee: { low: "1100000", med: "1200000", high: "1300000" },
  },
];

test("accepts the shape Circle actually returns", () => {
  const tier = selectFeeTier(LIVE_SHAPE, 1000);
  assert.equal(tier.minimumFeeBps, 1.3);
  assert.equal(tier.forwardFee, 275_486n);
});

test("computes a fractional basis-point fee exactly", () => {
  // 1.3bp of 10 USDC is exactly 1300 base units.
  assert.equal(protocolFee(10_000_000n, 1.3), 1_300n);
  // ...and anything above an exact multiple still rounds up.
  assert.equal(protocolFee(10_000_001n, 1.3), 1_301n);
});

test("prefers the requested finality tier", () => {
  const tier = selectFeeTier(SCHEDULE, 1000);
  assert.equal(tier.finalityThreshold, 1000);
  assert.equal(tier.minimumFeeBps, 1);
  assert.equal(tier.forwardFee, 1_200_000n);
});

test("falls back to the first tier when the preferred one is absent", () => {
  assert.equal(selectFeeTier(SCHEDULE, 9999).finalityThreshold, 2000);
});

test("uses the medium forward fee", () => {
  assert.equal(selectFeeTier(SCHEDULE, 2000).forwardFee, 900_000n);
});

test("rounds the protocol fee UP so maxFee is never underfunded", () => {
  // 1bp of 100.000001 USDC is 10000.0001 base units, which must become 10001.
  assert.equal(protocolFee(100_000_001n, 1), 10_001n);
  assert.equal(protocolFee(100_000_000n, 1), 10_000n);
  assert.equal(protocolFee(100_000_000n, 0), 0n);
});

test("rejects a malformed schedule rather than guessing", () => {
  assert.throws(() => selectFeeTier([], 1000));
  assert.throws(() => selectFeeTier({ nope: true }, 1000));
  assert.throws(() => selectFeeTier([{ finalityThreshold: 1000, minimumFee: 1 }], 1000));
  assert.throws(() =>
    selectFeeTier([{ finalityThreshold: 1000, minimumFee: 1, forwardFee: { med: "abc" } }], 1000),
  );
  assert.throws(() =>
    selectFeeTier([{ finalityThreshold: 1000, minimumFee: -1, forwardFee: { med: "1" } }], 1000),
  );
  assert.throws(() =>
    selectFeeTier([{ finalityThreshold: 1000, minimumFee: "1.3", forwardFee: { med: "1" } }], 1000),
  );
});

test("rejects a negative fee rate", () => {
  assert.throws(() => protocolFee(1n, -1));
});
