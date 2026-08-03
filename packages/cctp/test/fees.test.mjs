import assert from "node:assert/strict";
import test from "node:test";
import { protocolFee, selectFeeTier } from "../dist/index.js";

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
});

test("rejects a negative fee rate", () => {
  assert.throws(() => protocolFee(1n, -1));
});
