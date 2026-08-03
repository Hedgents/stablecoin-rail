# Generic CCTP Funding Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@hedgents/stablecoin-rail-cctp`, a source-chain-configurable Circle CCTP V2 funding provider that settles native USDC into a user's Solana wallet through the Forwarding Service.

**Architecture:** One plugin, many source chains. Ethereum, Base, Arbitrum, and every other CCTP domain are configuration entries rather than code. Quoting reads Circle's Iris fee schedule; preparation returns two EVM wallet steps (exact-amount approval, then `depositForBurnWithHook`); status polls Iris and surfaces the Solana delivery transaction, which the existing `-solana` verifier then turns into a confirmed amount.

**Tech Stack:** TypeScript (NodeNext, ES2022), `node --test` with `.mjs` files importing from `dist/`, `@noble/hashes` for keccak-256 selectors, `@hedgents/stablecoin-rail-solana` for base58 and ATA derivation. No viem.

## Global Constraints

- Spec: `docs/specs/2026-08-03-rail-completion-design.md`, phase **P4**. Satisfies terminal requirements **R1** and **R4**.
- **Never edit anything outside `stablecoin-rail/`.** `frontend/` belongs to another engineer.
- `packages/core` keeps **zero runtime dependencies**. This plan adds none to it.
- `tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- No test performs network I/O. Inject `fetch`.
- The plugin must pass `fundingProviderConformance` from `@hedgents/stablecoin-rail/testing`. If a case fails, fix the plugin.
- BNB Chain is **not** a CCTP source. Its common USDC is Binance-Peg and belongs to the separate `-mayan` adapter in P5. This package must never accept it.
- Do not mark any route Implemented in any document. No route has moved real value.

## Verified research (2026-08-03)

Confirmed against Circle's documentation on the date of writing. Re-verify before mainnet use.

**Contracts** (identical addresses across EVM chains, deployed via CREATE2):

| Contract | Address |
|---|---|
| TokenMessengerV2 | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| MessageTransmitterV2 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |

**Domain IDs:** Ethereum 0, Avalanche 1, OP Mainnet 2, Arbitrum 3, **Solana 5**, Base 6, Polygon PoS 7, Linea 11.

**Burn signature:**

```solidity
function depositForBurnWithHook(
    uint256 amount,
    uint32  destinationDomain,
    bytes32 mintRecipient,
    address burnToken,
    bytes32 destinationCaller,
    uint256 maxFee,
    uint32  minFinalityThreshold,
    bytes   hookData
) external;
```

**Forwarding Service hook layout for a Solana destination** (65 bytes total):

| Offset | Size | Content |
|---:|---:|---|
| 0 | 24 | ASCII `cctp-forward`, zero-padded to 24 bytes |
| 24 | 4 | version, uint32 big-endian, `0` |
| 28 | 4 | payload length, uint32 big-endian, `33` |
| 32 | 1 | create-ATA flag, `1` to create, `0` to skip |
| 33 | 32 | recipient Solana **wallet** address bytes (not the token account) |

**Fee endpoint:** `GET {apiBaseUrl}/v2/burn/USDC/fees/{sourceDomain}/{destinationDomain}?forward=true&includeRecipientSetup=true`, with production `apiBaseUrl` `https://iris-api.circle.com`. Returns an array of tiers, each with `finalityThreshold` (1000 fast, 2000 standard), `minimumFee` in basis points, and `forwardFee.low` / `.med` / `.high` in USDC base units. `includeRecipientSetup=true` makes the forward fee cover ATA rent, and must only be sent when the recipient's token account does not yet exist.

**Status endpoint:** `GET {apiBaseUrl}/v2/messages/{sourceDomain}?transactionHash={hash}`. A 404 means not yet indexed, which is `pending`, not a failure.

---

## File Structure

**Created**
- `packages/cctp/package.json`, `tsconfig.json`, `LICENSE`, `README.md`
- `packages/cctp/src/abi.ts` — keccak selectors and minimal ABI encoding, the only byte-level code
- `packages/cctp/src/hook.ts` — Forwarding Service hook construction
- `packages/cctp/src/fees.ts` — Iris fee schedule parsing and fee arithmetic
- `packages/cctp/src/chains.ts` — exported ready-made `CctpSourceChain` entries
- `packages/cctp/src/plugin.ts` — the funding provider
- `packages/cctp/src/types.ts`, `src/index.ts`
- `packages/cctp/test/abi.test.mjs`, `hook.test.mjs`, `fees.test.mjs`, `plugin.test.mjs`, `conformance.test.mjs`

**Modified**
- root `package.json` — add the package to build, typecheck, test, pack:check chains
- `README.md`, `docs/PRODUCT_VISION_AND_MVP.md` §9

Splitting `abi.ts`, `hook.ts`, and `fees.ts` from `plugin.ts` is deliberate: those three are pure, byte-exact, and independently testable, which is where encoding bugs hide. `plugin.ts` then contains only orchestration.

---

## Task 1: Package scaffold and ABI encoder

**Files:**
- Create: `packages/cctp/package.json`, `tsconfig.json`, `LICENSE`, `src/abi.ts`, `src/index.ts`
- Test: `packages/cctp/test/abi.test.mjs`
- Modify: root `package.json`

**Interfaces:**
- Produces: `selector(signature: string): Uint8Array`; `encodeApprove(spender: string, amount: bigint): \`0x${string}\``; `encodeDepositForBurnWithHook(args: DepositForBurnArgs): \`0x${string}\``; `DepositForBurnArgs` with fields `amount: bigint`, `destinationDomain: number`, `mintRecipient: \`0x${string}\``, `burnToken: string`, `destinationCaller: \`0x${string}\``, `maxFee: bigint`, `minFinalityThreshold: number`, `hookData: \`0x${string}\``.

- [ ] **Step 1: Create the manifest**

`packages/cctp/package.json`, modelled on `packages/solana/package.json`. Name `@hedgents/stablecoin-rail-cctp`, version `0.1.0`, description "Circle CCTP V2 funding provider for the Hedgents stablecoin rail." Dependencies:

```json
  "dependencies": {
    "@hedgents/stablecoin-rail": "0.2.0",
    "@hedgents/stablecoin-rail-solana": "0.1.0",
    "@noble/hashes": "^1.8.0"
  }
```

Copy `tsconfig.json` and `LICENSE` from `packages/solana`. Add the package to all four root script chains, positioned immediately after `@hedgents/stablecoin-rail-solana`.

- [ ] **Step 2: Write the failing test**

Create `packages/cctp/test/abi.test.mjs`. The selector expectations are fixed public values; the calldata expectations get pinned in Step 5 after cross-checking.

```js
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
  // address left-padded to 32 bytes, then the amount
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
  // Eight head words, so the tail offset is 8 * 32 = 256 = 0x100.
  assert.equal(body.slice(64 * 7, 64 * 8), "0".repeat(62) + "100");
  // Tail: length 65 (0x41), then the payload padded to a 32-byte boundary.
  assert.equal(body.slice(64 * 8, 64 * 9), "0".repeat(62) + "41");
  assert.equal(body.slice(64 * 9, 64 * 9 + 130), "22".repeat(65));
  // 65 bytes pads to 96, so the encoded body is 8 + 1 + 3 = 12 words.
  assert.equal(body.length, 64 * 12);
});

test("rejects a malformed address", () => {
  assert.throws(() => encodeApprove("0xnope", 1n));
});

test("rejects a value that does not fit in its slot", () => {
  assert.throws(() => encodeApprove("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", 2n ** 256n));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w @hedgents/stablecoin-rail-cctp`
Expected: FAIL, the package does not build.

- [ ] **Step 4: Implement the encoder**

Create `packages/cctp/src/abi.ts`:

```ts
import { keccak_256 } from "@noble/hashes/sha3";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x([0-9a-fA-F]{2})*$/;

export function selector(signature: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(signature)).slice(0, 4);
}

function hexToBytes(value: string, field: string): Uint8Array {
  if (!HEX.test(value)) throw new Error(`${field} must be 0x-prefixed hex of whole bytes.`);
  const body = value.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function word(value: bigint, field: string): string {
  if (value < 0n || value >= 2n ** 256n) throw new Error(`${field} does not fit in a uint256.`);
  return value.toString(16).padStart(64, "0");
}

function addressWord(value: string, field: string): string {
  if (!ADDRESS.test(value)) throw new Error(`${field} must be a 20-byte hex address.`);
  return value.slice(2).toLowerCase().padStart(64, "0");
}

function bytes32Word(value: string, field: string): string {
  if (!BYTES32.test(value)) throw new Error(`${field} must be exactly thirty-two bytes.`);
  return value.slice(2).toLowerCase();
}

function selectorHex(signature: string): string {
  return Array.from(selector(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function encodeApprove(spender: string, amount: bigint): `0x${string}` {
  return `0x${selectorHex("approve(address,uint256)")}${addressWord(spender, "spender")}${word(amount, "amount")}`;
}

export interface DepositForBurnArgs {
  amount: bigint;
  destinationDomain: number;
  mintRecipient: `0x${string}`;
  burnToken: string;
  destinationCaller: `0x${string}`;
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData: `0x${string}`;
}

const DEPOSIT_FOR_BURN_WITH_HOOK =
  "depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)";

export function encodeDepositForBurnWithHook(args: DepositForBurnArgs): `0x${string}` {
  const hook = hexToBytes(args.hookData, "hookData");
  const padded = Math.ceil(hook.length / 32) * 32;
  const tail =
    word(BigInt(hook.length), "hookData.length") +
    args.hookData.slice(2).toLowerCase().padEnd(padded * 2, "0");

  const head = [
    word(args.amount, "amount"),
    word(BigInt(args.destinationDomain), "destinationDomain"),
    bytes32Word(args.mintRecipient, "mintRecipient"),
    addressWord(args.burnToken, "burnToken"),
    bytes32Word(args.destinationCaller, "destinationCaller"),
    word(args.maxFee, "maxFee"),
    word(BigInt(args.minFinalityThreshold), "minFinalityThreshold"),
    // Eight head words precede the tail.
    word(256n, "hookDataOffset"),
  ].join("");

  return `0x${selectorHex(DEPOSIT_FOR_BURN_WITH_HOOK)}${head}${tail}`;
}
```

Create `packages/cctp/src/index.ts` exporting everything from `./abi.js`.

- [ ] **Step 5: Cross-check the calldata against an independent encoder**

The encoder is the highest-risk code in this package: a wrong byte moves real money to the wrong place. Verify it against `viem`, which is already installed at `/Users/tobiasd/Desktop/Hedgents/frontend/node_modules/viem` (read-only use of an installed library; do **not** modify anything under `frontend/`).

Write a throwaway script in your scratchpad that calls viem's `encodeFunctionData` with the same ABI and arguments as the test above, and prints both encodings. Confirm they are byte-identical for at least three cases: a 65-byte hook, an empty hook, and a hook whose length is an exact multiple of 32.

If they differ, fix `abi.ts`. Delete the script; nothing from it ships.

- [ ] **Step 6: Run the tests**

Run: `npm install && npm test -w @hedgents/stablecoin-rail-cctp`
Expected: PASS, all five tests.

- [ ] **Step 7: Commit**

```bash
git add packages/cctp package.json package-lock.json
git commit -m "feat(cctp): add the package scaffold and a minimal ABI encoder"
```

---

## Task 2: Forwarding Service hook

**Files:**
- Create: `packages/cctp/src/hook.ts`
- Modify: `packages/cctp/src/index.ts`
- Test: `packages/cctp/test/hook.test.mjs`

**Interfaces:**
- Consumes: `decodeBase58` from `@hedgents/stablecoin-rail-solana`.
- Produces: `buildSolanaForwardHook(recipientWallet: string, createTokenAccount: boolean): \`0x${string}\``.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { buildSolanaForwardHook } from "../dist/index.js";
import { decodeBase58 } from "@hedgents/stablecoin-rail-solana";

const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

test("lays out the forwarding hook exactly", () => {
  const hook = buildSolanaForwardHook(WALLET, true);
  const bytes = Buffer.from(hook.slice(2), "hex");
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
  // A different wallet must change the trailing thirty-two bytes.
  const a = buildSolanaForwardHook(WALLET, true);
  const b = buildSolanaForwardHook("7VHUFJHWu2CuExkJcJrzhQPJ2oygupTWkL2A2For4BmE", true);
  assert.notEqual(a.slice(-64), b.slice(-64));
});

test("rejects a wallet that is not thirty-two bytes", () => {
  assert.throws(() => buildSolanaForwardHook("abc", true));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @hedgents/stablecoin-rail-cctp`
Expected: FAIL with `buildSolanaForwardHook is not a function`.

- [ ] **Step 3: Implement the hook**

```ts
import { decodeBase58 } from "@hedgents/stablecoin-rail-solana";

const MAGIC = "cctp-forward";
const MAGIC_BYTES = 24;
const VERSION = 0;
const PAYLOAD_LENGTH = 33; // one flag byte plus a thirty-two byte wallet

/**
 * Hook payload that tells Circle's Forwarding Service to deliver the minted
 * USDC to a Solana wallet, optionally creating its associated token account.
 *
 * The trailing thirty-two bytes are the user's WALLET, not their token
 * account: the service derives the account itself.
 */
export function buildSolanaForwardHook(
  recipientWallet: string,
  createTokenAccount: boolean,
): `0x${string}` {
  const wallet = decodeBase58(recipientWallet);
  if (wallet.length !== 32) {
    throw new Error("The forwarding recipient must be a base58 Solana wallet address.");
  }
  const out = new Uint8Array(MAGIC_BYTES + 4 + 4 + 1 + 32);
  out.set(new TextEncoder().encode(MAGIC), 0);
  const view = new DataView(out.buffer);
  view.setUint32(MAGIC_BYTES, VERSION, false);
  view.setUint32(MAGIC_BYTES + 4, PAYLOAD_LENGTH, false);
  out[MAGIC_BYTES + 8] = createTokenAccount ? 1 : 0;
  out.set(wallet, MAGIC_BYTES + 9);
  return `0x${Array.from(out, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
```

Export it from `src/index.ts`.

- [ ] **Step 4: Run the tests**

Run: `npm test -w @hedgents/stablecoin-rail-cctp`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cctp
git commit -m "feat(cctp): build the Solana forwarding-service hook"
```

---

## Task 3: Fee schedule

**Files:**
- Create: `packages/cctp/src/fees.ts`
- Test: `packages/cctp/test/fees.test.mjs`

**Interfaces:**
- Produces: `selectFeeTier(payload: unknown, preferred: number): { finalityThreshold: number; minimumFeeBps: number; forwardFee: bigint }`; `protocolFee(amount: bigint, minimumFeeBps: number): bigint`.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { protocolFee, selectFeeTier } from "../dist/index.js";

const SCHEDULE = [
  { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: "800000", med: "900000", high: "1000000" } },
  { finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: "1100000", med: "1200000", high: "1300000" } },
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

test("rounds the protocol fee UP so maxFee is never underfunded", () => {
  // 1 bp of 100.000001 USDC is 10000.0001 base units, which must round to 10001.
  assert.equal(protocolFee(100_000_001n, 1), 10_001n);
  assert.equal(protocolFee(100_000_000n, 1), 10_000n);
  assert.equal(protocolFee(100_000_000n, 0), 0n);
});

test("rejects a malformed schedule rather than guessing", () => {
  assert.throws(() => selectFeeTier([], 1000));
  assert.throws(() => selectFeeTier({ nope: true }, 1000));
  assert.throws(() => selectFeeTier([{ finalityThreshold: 1000 }], 1000));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @hedgents/stablecoin-rail-cctp`
Expected: FAIL with `selectFeeTier is not a function`.

- [ ] **Step 3: Implement**

Create `packages/cctp/src/fees.ts`. `selectFeeTier` finds the entry whose `finalityThreshold` matches `preferred`, falling back to the first entry; it throws if the payload is not a non-empty array or if `finalityThreshold`, `minimumFee`, or `forwardFee.med` is missing or not an integer string. `protocolFee` computes `ceil(amount * bps / 10_000)` in `bigint`:

```ts
export function protocolFee(amount: bigint, minimumFeeBps: number): bigint {
  if (!Number.isInteger(minimumFeeBps) || minimumFeeBps < 0) {
    throw new Error("The CCTP minimum fee must be a non-negative integer in basis points.");
  }
  const numerator = amount * BigInt(minimumFeeBps);
  // Round up: a maxFee below the fee Circle charges makes the burn unusable.
  return numerator === 0n ? 0n : (numerator + 9_999n) / 10_000n;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w @hedgents/stablecoin-rail-cctp`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cctp
git commit -m "feat(cctp): parse the Circle fee schedule and round the protocol fee up"
```

---

## Task 4: The funding provider

**Files:**
- Create: `packages/cctp/src/chains.ts`, `src/types.ts`, `src/plugin.ts`
- Modify: `packages/cctp/src/index.ts`
- Test: `packages/cctp/test/plugin.test.mjs`

**Interfaces:**
- Consumes: everything above, plus `deriveAssociatedTokenAddress` and `toBytes32` from `-solana`.
- Produces: `CctpSourceChain`; `createCctpToSolana(options: CctpOptions): FundingProviderPlugin`; exported presets `ETHEREUM_MAINNET`, `BASE_MAINNET`, `ARBITRUM_MAINNET`.

```ts
export interface CctpSourceChain {
  chainId: string;            // CAIP-2, e.g. "eip155:1"
  numericChainId: number;
  cctpDomain: number;
  usdcAddress: `0x${string}`;
  tokenMessengerV2: `0x${string}`;
}

export interface CctpOptions {
  sources: CctpSourceChain[];
  solana: { chainId: string; usdcMint: string; cctpDomain: number };
  /** Used only to check whether the recipient's token account already exists. */
  rpcUrl: string;
  apiBaseUrl?: string;        // default https://iris-api.circle.com
  finalityThreshold?: number; // default 1000 (fast)
  quoteTtlSeconds?: number;   // default 90
  fetch?: typeof globalThis.fetch;
}
```

- [ ] **Step 1: Write the failing test**

Create `packages/cctp/test/plugin.test.mjs` with an injected `fetch` routing on URL path: `/v2/burn/` returns the fee schedule, the Solana RPC URL returns a `getAccountInfo` result, and `/v2/messages/` returns status. Assert:

1. `supports` accepts an Ethereum USDC to Solana USDC intent.
2. `supports` rejects an unconfigured source chain, a non-USDC source asset, and a non-Solana destination.
3. `quote` sets `minimumOutput = amount - (forwardFee + protocolFee)` and lists both fees in `fees[]` with types `forwarding` and `provider`.
4. `quote` sends `includeRecipientSetup=true` only when `getAccountInfo` reports the derived token account is null.
5. `quote` throws when the amount does not clear the fee plus buffer.
6. `quote` publishes an `opaqueData` record with `schema`, `sourceDomain`, `destinationDomain`, `tokenMessengerV2`, `destinationTokenAccount`, `mintRecipient`, `recipientSetupIncluded`, `forwardFee`, `protocolFee`, `maxFee`, `finalityThreshold`, and `hookData`. **This satisfies terminal requirement R4**: a host must be able to render full cost and recipient disclosure from the quote alone.
7. `prepare` returns exactly two steps: an approval whose amount equals the input exactly (assert it is **not** `2^256-1`), then the burn to `tokenMessengerV2`, both with `value: "0"` and the correct `numericChainId`.
8. `prepare` throws when the quote's `opaqueData` pins do not match the intent, mirroring `requirePinnedQuote` in `packages/layerzero/src/plugin.ts`.
9. `getStatus` maps a 404 to `pending`, an attested-and-minted message to `completed` with the Solana transaction as `destinationReference`, and leaves `received` null so the `-solana` verifier supplies it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @hedgents/stablecoin-rail-cctp`
Expected: FAIL with `createCctpToSolana is not a function`.

- [ ] **Step 3: Implement `chains.ts`**

```ts
import type { CctpSourceChain } from "./types.js";

const TOKEN_MESSENGER_V2 = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as const;

export const ETHEREUM_MAINNET: CctpSourceChain = {
  chainId: "eip155:1",
  numericChainId: 1,
  cctpDomain: 0,
  usdcAddress: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  tokenMessengerV2: TOKEN_MESSENGER_V2,
};

export const BASE_MAINNET: CctpSourceChain = {
  chainId: "eip155:8453",
  numericChainId: 8453,
  cctpDomain: 6,
  usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  tokenMessengerV2: TOKEN_MESSENGER_V2,
};

export const ARBITRUM_MAINNET: CctpSourceChain = {
  chainId: "eip155:42161",
  numericChainId: 42161,
  cctpDomain: 3,
  usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  tokenMessengerV2: TOKEN_MESSENGER_V2,
};

export const SOLANA_MAINNET = {
  chainId: "solana:mainnet",
  usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  cctpDomain: 5,
} as const;
```

Verify each USDC address against Circle's documentation before use. Do **not** add a BNB Chain entry; its common USDC is Binance-Peg and is not a CCTP source asset.

- [ ] **Step 4: Implement `plugin.ts`**

Model the structure on `packages/layerzero/src/plugin.ts`: a `supportsRoute` guard, a `quote` that returns `null` for unsupported intents rather than throwing, a `requirePinnedQuote` that re-verifies every `opaqueData` pin before preparation, and `RailPluginError` with an explicit code for each failure.

Quote flow: resolve the source chain from `intent.source.account.chainId`; derive the destination token account with `deriveAssociatedTokenAddress(wallet, usdcMint)`; check its existence with a `getAccountInfo` RPC call; request the fee schedule with `includeRecipientSetup` set accordingly; compute `maxFee = forwardFee + protocolFee(amount, minimumFeeBps)`; reject when `amount <= maxFee + 1_000_000n`; set `minimumOutput = amount - maxFee`; build `hookData` with `buildSolanaForwardHook(wallet, !exists)`; set `mintRecipient = toBytes32(destinationTokenAccount)` and `destinationCaller` to 32 zero bytes.

Prepare flow: return `encodeApprove(tokenMessengerV2, amount)` then `encodeDepositForBurnWithHook({...})`, both as `EvmTransactionRequest` with `value: "0"`, `numericChainId` from the source chain, and `chainId` equal to `eip155:${numericChainId}` so core's `validateWalletSteps` passes.

- [ ] **Step 5: Run the tests**

Run: `npm test -w @hedgents/stablecoin-rail-cctp`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cctp
git commit -m "feat(cctp): add the source-configurable CCTP funding provider"
```

---

## Task 5: Conformance, docs, and workspace verification

**Files:**
- Create: `packages/cctp/test/conformance.test.mjs`, `packages/cctp/README.md`
- Modify: root `README.md`, `docs/PRODUCT_VISION_AND_MVP.md`

- [ ] **Step 1: Run the plugin against the conformance suite**

Create `packages/cctp/test/conformance.test.mjs` following `packages/layerzero/test/conformance.test.mjs`. The supported intent is Ethereum USDC to Solana USDC; the unsupported intent is the same route sourced from `eip155:56` (BNB), which this package must decline.

```js
for (const item of fundingProviderConformance({ plugin, supportedIntent, unsupportedIntent, now })) {
  test(`CCTP provider: ${item.name}`, async () => { await item.run(); });
}
```

If a case fails, fix the plugin.

- [ ] **Step 2: Write the package README**

Cover configuration, the two wallet steps, why the approval is exact rather than unlimited, that the hook carries the wallet and not the token account, and that `received` is intentionally left null for `@hedgents/stablecoin-rail-solana` to supply.

- [ ] **Step 3: Update the repository docs**

Add the package to the root `README.md` list. In `docs/PRODUCT_VISION_AND_MVP.md` §9, move "Production CCTP server adapter" to Completed and add to Not completed: "No CCTP route has completed a small-value mainnet transfer."

**Do not change the §8 route matrix.** Ethereum USDC stays **Integration scaffold** until a real transfer settles.

- [ ] **Step 4: Verify the whole workspace**

Run: `npm run typecheck && npm test && npm run pack:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(cctp): pass conformance and document the provider"
```

---

## Risks

| Risk | Handling |
|---|---|
| Encoder produces wrong calldata | Task 1 Step 5 cross-checks against viem across three hook lengths; a mismatch blocks the task |
| Circle changes the fee schedule shape | `selectFeeTier` throws on anything unexpected rather than guessing; fixtures are dated |
| Forwarding hook layout drifts | Byte-offset assertions in `hook.test.mjs` fail loudly rather than silently misdelivering |
| A wrong USDC address on a preset chain | Verify every address against Circle's docs in Task 4 Step 3 before use |
| Mis-checksummed addresses in presets | **Found during Task 1:** the Ethereum USDC address used in the existing core test fixtures (`0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`) fails EIP-55; the correct casing is `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`. Harmless to our own lowercase-normalising encoder, but wallets and viem-based hosts reject it. Every address in `chains.ts` must be EIP-55 correct, and Task 4 should assert this |
| BNB leaking into this package | An explicit conformance case asserts `eip155:56` is declined |
| `maxFee` underfunded by rounding | `protocolFee` rounds up, with a test pinning the fractional case |
