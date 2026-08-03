import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveAssociatedTokenAddress,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "../dist/index.js";

// Golden vectors. Every expected value below was produced by an independent
// implementation (@solana/addresses getProgramDerivedAddress) and matched
// byte for byte, so these pin behaviour rather than restating our own output.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER_MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SECOND_OWNER = "7VHUFJHWu2CuExkJcJrzhQPJ2oygupTWkL2A2For4BmE";

test("derives the canonical associated token account", () => {
  assert.equal(
    deriveAssociatedTokenAddress(OWNER, USDC_MINT),
    "FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B",
  );
  assert.equal(
    deriveAssociatedTokenAddress(SECOND_OWNER, USDC_MINT),
    "4kokFKCFMxpCpG41yLYkLEqXW8g1WPfCt2NC9KGivY6N",
  );
});

test("the token program is part of the seeds", () => {
  assert.equal(
    deriveAssociatedTokenAddress(OWNER, USDC_MINT, TOKEN_2022_PROGRAM_ID),
    "GdjpegrtGwU3pgtzPivYVViSA8rmGL248qBVKzsrU3DD",
  );
  assert.notEqual(
    deriveAssociatedTokenAddress(OWNER, USDC_MINT, SPL_TOKEN_PROGRAM_ID),
    deriveAssociatedTokenAddress(OWNER, USDC_MINT, TOKEN_2022_PROGRAM_ID),
  );
});

test("the mint is part of the seeds", () => {
  assert.equal(
    deriveAssociatedTokenAddress(OWNER, OTHER_MINT),
    "7ED1ycArr6BoBxJk4FKVr6aRQxhvZboYZy9VH4ek2mnU",
  );
});

// Guards the on-curve rejection specifically. For this owner the bump-255
// candidate IS a valid ed25519 point, so an implementation that skipped the
// curve check would return that address instead and be silently wrong.
test("walks past an on-curve candidate to the correct bump", () => {
  assert.equal(
    deriveAssociatedTokenAddress("9rdA3rUq2hxNK5TJzKPNZpnqxfCGmRnqEJBDEmCdY7qt", USDC_MINT),
    "3ZBZcQy4yQepLJk4Ct1ga5orRKYJPhpgtFaQmCNxqWs1",
  );
});

test("derivation is deterministic", () => {
  assert.equal(
    deriveAssociatedTokenAddress(OWNER, USDC_MINT),
    deriveAssociatedTokenAddress(OWNER, USDC_MINT),
  );
});

test("rejects a malformed owner", () => {
  assert.throws(() => deriveAssociatedTokenAddress("not-an-address", USDC_MINT));
});

test("rejects a malformed mint", () => {
  assert.throws(() => deriveAssociatedTokenAddress(OWNER, "abc"));
});
