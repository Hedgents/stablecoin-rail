import assert from "node:assert/strict";
import test from "node:test";
import {
  assessLiquidity,
  createAllbridgePoolReader,
  readPoolDepth,
  SYSTEM_PRECISION,
} from "../dist/index.js";

// Recorded from https://core.api.allbridgecoreapi.net/token-info on 2026-08-03.
// tokenBalance + vUsdBalance reconciles with dValue, which is what confirms the
// 3-decimal system precision rather than the token's own 6.
const TRX_USDT = {
  symbol: "USDT",
  decimals: 6,
  poolInfo: { tokenBalance: "384231099", vUsdBalance: "558712187", dValue: "942536120" },
};
const SOL_USDT = {
  symbol: "USDT",
  decimals: 6,
  poolInfo: { tokenBalance: "127192405", vUsdBalance: "203978182", dValue: "330941602" },
};

const usdt = (whole) => BigInt(whole) * 1_000_000n;

test("scales system precision up to the token's own base units", () => {
  assert.equal(SYSTEM_PRECISION, 3);
  const depth = readPoolDepth(SOL_USDT, "SOL");
  // 127192405 at 3dp is 127,192.405 USDT, which is 127192405000 base units at 6dp.
  assert.equal(depth.tokenBaseUnits, 127_192_405_000n);
  assert.equal(depth.decimals, 6);
});

test("reports how token-poor a pool is", () => {
  // 127192405 / (127192405 + 203978182) = 38.4%
  assert.equal(readPoolDepth(SOL_USDT, "SOL").tokenSharePct, 38.4);
  assert.equal(readPoolDepth(TRX_USDT, "TRX").tokenSharePct, 40.74);
});

test("measures the transfer against the DESTINATION pool, not the source", () => {
  const source = readPoolDepth(TRX_USDT, "TRX");
  const destination = readPoolDepth(SOL_USDT, "SOL");
  // $10k is 7.86% of Solana's 127k, but only 2.6% of TRON's 384k. The
  // destination is what has to pay out, so that is the number that counts.
  const a = assessLiquidity(source, destination, usdt(10_000));
  assert.equal(a.destinationSharePct, 7.86);
});

test("bands scale with the share of destination depth", () => {
  const source = readPoolDepth(TRX_USDT, "TRX");
  const balanced = { ...readPoolDepth(SOL_USDT, "SOL"), tokenSharePct: 50 };
  const band = (whole) => assessLiquidity(source, balanced, usdt(whole)).band;
  assert.equal(band(100), "low");
  assert.equal(band(2_000), "moderate");
  assert.equal(band(10_000), "high");
  assert.equal(band(50_000), "severe");
});

test("a depleted destination pool is severe at any size", () => {
  const source = readPoolDepth(TRX_USDT, "TRX");
  const drained = { ...readPoolDepth(SOL_USDT, "SOL"), tokenSharePct: 12 };
  const a = assessLiquidity(source, drained, usdt(1));
  assert.equal(a.band, "severe");
  assert.match(a.reason, /low on USDT/);
});

test("explains itself in language a first-time user can read", () => {
  const a = assessLiquidity(
    readPoolDepth(TRX_USDT, "TRX"),
    { ...readPoolDepth(SOL_USDT, "SOL"), tokenSharePct: 50 },
    usdt(100),
  );
  assert.match(a.reason, /comfortably deep/);
  assert.ok(!/vUsd|dValue|invariant/i.test(a.reason), "no internal jargon in user-facing copy");
});

test("rejects a malformed registry rather than guessing", () => {
  assert.throws(() => readPoolDepth({ decimals: 6 }, "SOL"));
  assert.throws(() => readPoolDepth({ decimals: 6, poolInfo: { tokenBalance: "x" } }, "SOL"));
  assert.throws(() => readPoolDepth({ ...SOL_USDT, decimals: 2 }, "SOL"));
});

test("reads the live registry shape end to end", async () => {
  const reader = createAllbridgePoolReader({
    fetch: async () =>
      new Response(JSON.stringify({ TRX: { tokens: [TRX_USDT] }, SOL: { tokens: [SOL_USDT] } }), {
        headers: { "content-type": "application/json" },
      }),
  });
  const a = await reader.assess({
    sourceChainKey: "TRX",
    destinationChainKey: "SOL",
    symbol: "USDT",
    amountBaseUnits: usdt(1_000),
  });
  assert.equal(a.destinationSharePct, 0.78);
  assert.equal(a.band, "low");
});

test("fails clearly when a chain or symbol is absent", async () => {
  const reader = createAllbridgePoolReader({
    fetch: async () =>
      new Response(JSON.stringify({ SOL: { tokens: [SOL_USDT] } }), {
        headers: { "content-type": "application/json" },
      }),
  });
  await assert.rejects(
    () => reader.assess({ sourceChainKey: "TRX", destinationChainKey: "SOL", symbol: "USDT", amountBaseUnits: usdt(1) }),
    /does not list chain TRX/,
  );
});

test("rescales a 6-decimal source amount against an 18-decimal destination pool", () => {
  // BSC-style token: 18 decimals, 60,000 tokens deep, balanced.
  const bsc = readPoolDepth(
    {
      symbol: "USDT",
      decimals: 18,
      poolInfo: { tokenBalance: "60000000", vUsdBalance: "60000000", dValue: "120000000" },
    },
    "BSC",
  );
  const trx = readPoolDepth(
    {
      symbol: "USDT",
      decimals: 6,
      poolInfo: { tokenBalance: "60000000", vUsdBalance: "60000000", dValue: "120000000" },
    },
    "TRX",
  );
  // 50,000 USDT from a 6-decimal source into a 60,000-token destination pool
  // is ~83% of destination depth: severe, not "comfortably deep enough".
  const severe = assessLiquidity(trx, bsc, 50_000_000_000n);
  assert.equal(severe.band, "severe");
  assert.ok(severe.destinationSharePct > 80 && severe.destinationSharePct < 85);

  // The reverse direction: an 18-decimal source amount must not read as
  // astronomically large against a 6-decimal destination pool.
  const small = assessLiquidity(bsc, trx, 100n * 10n ** 18n);
  assert.equal(small.band, "low");
});
