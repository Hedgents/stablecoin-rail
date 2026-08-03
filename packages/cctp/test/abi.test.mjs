import assert from "node:assert/strict";
import test from "node:test";
import { encodeApprove, encodeDepositForBurnWithHook, selector } from "../dist/index.js";

const hex = (bytes) => `0x${Buffer.from(bytes).toString("hex")}`;

test("computes the canonical ERC-20 approve selector", () => {
  assert.equal(hex(selector("approve(address,uint256)")), "0x095ea7b3");
});

test("computes the canonical transfer selector", () => {
  assert.equal(hex(selector("transfer(address,uint256)")), "0xa9059cbb");
});

test("encodes an exact-amount approval", () => {
  const data = encodeApprove("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", 100_000_000n);
  assert.equal(data.slice(0, 10), "0x095ea7b3");
  assert.equal(
    data.slice(10),
    "00000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d" +
      "0000000000000000000000000000000000000000000000000000000005f5e100",
  );
  assert.equal(data.length, 2 + 8 + 64 * 2);
});

test("encodes depositForBurnWithHook with a dynamic tail", () => {
  const data = encodeDepositForBurnWithHook({
    amount: 100_000_000n,
    destinationDomain: 5,
    mintRecipient: `0x${"11".repeat(32)}`,
    burnToken: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    destinationCaller: `0x${"00".repeat(32)}`,
    maxFee: 1_500n,
    minFinalityThreshold: 1000,
    hookData: `0x${"22".repeat(65)}`,
  });
  const body = data.slice(10);
  assert.equal(body.slice(64 * 7, 64 * 8), "0".repeat(61) + "100");
  assert.equal(body.slice(64 * 8, 64 * 9), "0".repeat(62) + "41");
  assert.equal(body.slice(64 * 9, 64 * 9 + 130), "22".repeat(65));
  assert.equal(body.length, 64 * 12);
});

test("encodes an empty hook", () => {
  const data = encodeDepositForBurnWithHook({
    amount: 1n,
    destinationDomain: 5,
    mintRecipient: `0x${"11".repeat(32)}`,
    burnToken: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    destinationCaller: `0x${"00".repeat(32)}`,
    maxFee: 0n,
    minFinalityThreshold: 2000,
    hookData: "0x",
  });
  assert.equal(data.slice(10).length, 64 * 9);
});

test("rejects a malformed address", () => {
  assert.throws(() => encodeApprove("0xnope", 1n));
});

test("rejects a value that does not fit in its slot", () => {
  assert.throws(() => encodeApprove("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", 2n ** 256n));
});
