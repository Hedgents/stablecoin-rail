import assert from "node:assert/strict";
import test from "node:test";
import { decodeBase58, encodeBase58, toBytes32 } from "../dist/index.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

test("decodes a Solana mint to thirty-two bytes", () => {
  assert.equal(decodeBase58(USDC_MINT).length, 32);
});

test("round-trips base58", () => {
  assert.equal(encodeBase58(decodeBase58(USDC_MINT)), USDC_MINT);
});

test("round-trips the all-zero system program address", () => {
  const bytes = decodeBase58(SYSTEM_PROGRAM);
  assert.equal(bytes.length, 32);
  assert.ok(bytes.every((byte) => byte === 0));
  assert.equal(encodeBase58(bytes), SYSTEM_PROGRAM);
});

test("preserves leading zero bytes as leading ones", () => {
  const bytes = new Uint8Array([0, 0, 1]);
  const encoded = encodeBase58(bytes);
  assert.equal(encoded.slice(0, 2), "11");
  assert.deepEqual(decodeBase58(encoded), bytes);
});

test("rejects characters outside the alphabet", () => {
  assert.throws(() => decodeBase58("0OIl"));
});

test("renders a thirty-two byte address as hex", () => {
  const hex = toBytes32(USDC_MINT);
  assert.match(hex, /^0x[0-9a-f]{64}$/);
  assert.equal(hex, `0x${Buffer.from(decodeBase58(USDC_MINT)).toString("hex")}`);
});

test("refuses to render an address that is not thirty-two bytes", () => {
  assert.throws(() => toBytes32("abc"));
});
