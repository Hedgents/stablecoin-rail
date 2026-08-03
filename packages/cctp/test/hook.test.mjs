import assert from "node:assert/strict";
import test from "node:test";
import { decodeBase58 } from "@hedgents/stablecoin-rail-solana";
import { buildSolanaForwardHook } from "../dist/index.js";

const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OTHER_WALLET = "7VHUFJHWu2CuExkJcJrzhQPJ2oygupTWkL2A2For4BmE";

test("lays out the forwarding hook exactly", () => {
  const bytes = Buffer.from(buildSolanaForwardHook(WALLET, true).slice(2), "hex");
  assert.equal(bytes.length, 65);
  assert.equal(bytes.subarray(0, 12).toString("utf8"), "cctp-forward");
  assert.ok(bytes.subarray(12, 24).every((byte) => byte === 0), "magic must be zero-padded to 24");
  assert.equal(bytes.readUInt32BE(24), 0, "version");
  assert.equal(bytes.readUInt32BE(28), 33, "payload length");
  assert.equal(bytes[32], 1, "create-ATA flag");
  assert.deepEqual(new Uint8Array(bytes.subarray(33)), decodeBase58(WALLET));
});

test("clears the flag when the token account already exists", () => {
  const bytes = Buffer.from(buildSolanaForwardHook(WALLET, false).slice(2), "hex");
  assert.equal(bytes[32], 0);
  assert.equal(bytes.length, 65);
});

test("carries the wallet, never the token account", () => {
  assert.notEqual(
    buildSolanaForwardHook(WALLET, true).slice(-64),
    buildSolanaForwardHook(OTHER_WALLET, true).slice(-64),
  );
});

test("only the flag byte differs between the two setup modes", () => {
  const on = buildSolanaForwardHook(WALLET, true);
  const off = buildSolanaForwardHook(WALLET, false);
  assert.equal(on.slice(0, 66), off.slice(0, 66));
  assert.equal(on.slice(68), off.slice(68));
});

test("rejects a wallet that is not thirty-two bytes", () => {
  assert.throws(() => buildSolanaForwardHook("abc", true));
});
