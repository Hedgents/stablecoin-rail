# Stablecoin Rail completion design

**Date:** 2026-08-03
**Status:** Approved design, not yet implemented
**Scope:** `stablecoin-rail/` only. Nothing in this document changes `frontend/`.

---

## 1. Context

`PRODUCT_VISION_AND_MVP.md` describes the rail as a provider-neutral, non-custodial SDK for bringing stablecoin capital into a Solana application. Today the repository contains a working core (`RailClient`, `RailFlow`, plugin contracts, quote ranking, validation), a React hook, and one provider adapter (`-layerzero`, TRON USDT to Solana USDT, gated). Twelve tests pass.

This round finishes the SDK **as an open-source horizontal product** targeted at outside adopters and a Solana Foundation grant. The Hedgents metal terminal is explicitly not part of the deliverable; adopters configure the SDK for their own application.

### Decisions taken before this design

| Decision | Value |
|---|---|
| Deliverable | Open-source SDK, not the Hedgents terminal checkout |
| Terminal boundary | `frontend/` is owned by a colleague and must not be edited |
| Split rule | Cross-chain stablecoin routing belongs in the SDK; Hedgents metal logic stays in the terminal |
| Completion bar | TRON route ready to prove, plus a second provider so the SDK is not a one-bridge wrapper |
| First production route | TRON USDT via USDT0/LayerZero |
| Sequencing | Core contract first, then providers, then reference app |
| Persistence | Core serializes, host stores |
| Dependency policy | Core stays zero-dependency; provider packages may take minimal audited dependencies |
| CCTP encoding | Hand-rolled encoder with golden-vector tests, no viem |
| Conformance suite | In scope this round |

### What this round cannot deliver

The TRON mainnet proof itself. It requires a LayerZero production API key, the official current USDT0 target and recipient allowlist, and funded TRON and Solana wallets. None are available. Every prerequisite is built and the route stays gated, with an ordered activation checklist (section 8) to run once those exist.

---

## 2. Deliverables

| # | Item | Package |
|---|---|---|
| 1 | Optional destination action | core |
| 2 | Resumable flow (serialize plus hydrate) | core |
| 3 | Settlement verification | core interface, `-solana` implementation |
| 4 | Generic CCTP funding provider | `-cctp` (new) |
| 5 | Mayan funding provider | `-mayan` (new) |
| 6 | Remote transport, keeps secrets server-side | `core/remote` |
| 7 | Plugin conformance suite | `core/testing` |
| 8 | Reference application | `examples/reference-app` |
| 9 | TRON activation checklist and honest route matrix | `docs/` |

### Package layout after the work

```text
packages/
  core/          @hedgents/stablecoin-rail            zero dependencies
    src/testing/                                      conformance suite, runner-agnostic
    src/remote/                                       HTTP transport, client and server halves
  solana/        @hedgents/stablecoin-rail-solana     @noble/hashes, @noble/curves
  cctp/          @hedgents/stablecoin-rail-cctp       depends on -solana for pure helpers
  mayan/         @hedgents/stablecoin-rail-mayan      depends on -solana for pure helpers
  layerzero/     @hedgents/stablecoin-rail-layerzero  unchanged transport, updated for received
  react/         @hedgents/stablecoin-rail-react      peer: react
examples/
  solana-jupiter/                                     existing boundary example
  reference-app/                                      new, runnable
```

`-cctp` depending on `-solana` is intentional: the route is EVM to Solana, so it legitimately needs Solana address helpers. Only the pure helpers are imported, not the RPC verifier.

### Build order

Core contract first, so every provider is written once against final interfaces.

| Phase | Contents | Gate to the next phase |
|---|---|---|
| **P1** | Core: optional action, resume, `SettlementVerifier` interface. Version `0.2.0`. | Core tests green; `-layerzero` still compiles and passes |
| **P2** | `-solana`: pure helpers plus the RPC verifier. | Golden vectors pass; `-layerzero` returns a non-null `received` against recorded fixtures |
| **P3** | `core/testing` conformance suite, validated against `-layerzero`. | `-layerzero` passes its own suite |
| **P4** | `-cctp`: encoder, quote, prepare, status. | Byte-exact encoder fixtures pass; passes conformance |
| **P5** | `-mayan`: quote, prepare, status. | Passes conformance |
| **P6** | `core/remote`: client-side proxy plugins plus server handler. | A provider behind the transport passes the same conformance suite as the direct one |
| **P7** | `examples/reference-app`; `docs/ACTIVATION_TRON.md`; route matrix update. | App drives a full funding-only and full action flow against fixtures |

Two ordering choices are deliberate. The conformance suite lands at P3, before the two new providers, so `-cctp` and `-mayan` are written against an enforceable contract rather than validated after the fact. And the optional action lands in P1 because a funding-only intent is the simplest possible integration test for a new provider: CCTP should be exercisable without dragging a destination-action quote into it.

### First-party consumer requirements

Verified 2026-08-03: the Hedgents terminal has removed its funding layer. `cctp-server.ts`, `mayan-server.ts`, `funding-constants.ts`, `funding-types.ts`, `funding-status.ts`, `funding-validation.ts`, and `CrossChainFundingPanel.tsx` no longer exist there. The terminal therefore has no cross-chain funding until this SDK provides it, which puts these requirements on the critical path.

| # | Requirement | Phase |
|---|---|---|
| R1 | Ethereum USDC to Solana USDC over native Circle CCTP | P4 |
| R2 | BNB Binance-Peg USDC to Solana USDC over Mayan, labelled an adapter route and never as CCTP | P5 |
| R3 | Provider calls executable server-side so no credential reaches the browser | P6 |
| R4 | `opaqueData` carries a documented, stable disclosure payload | P4, P5 |
| R5 | A thin third-party destination action is easy to write correctly | P3 |
| R6 | Funding-only works, so funding can be adopted before the purchase leg is wired | P1 |

**On R4.** The terminal's UI previously rendered forwarding fee, protocol fee, max fee, finality threshold, destination token account, mint recipient, recipient-setup flag, and the source contract target. Those do not fit `FundingQuote`'s typed fields, so each provider publishes a versioned `opaqueData` record under a `schema` key, exactly as `-layerzero` already does. A host must be able to render full cost, route, and recipient disclosure from the quote alone, without a second call into the provider.

**On R5.** Jupiter execution stays in the terminal: it is metal-product logic under the agreed split. The SDK's obligation is that wrapping it in a `DestinationActionPlugin` is small and verifiable, which is what the conformance suite delivers.

**Note on `-mayan` provenance.** The terminal's Mayan implementation was deleted before it could be read, so `-mayan` is built from Mayan's published Quote, Forwarder, and Explorer API documentation rather than ported. Its request and response shapes must be verified against current docs before implementation, and pinned in fixtures afterwards.

---

## 3. Optional destination action

### Rationale

Many adopters want stablecoin delivered into their user's Solana wallet and nothing more. Today `FundingIntent.action` is required, `quote()` fails without a registered action plugin, and the constructor throws `NO_DESTINATION_ACTIONS`. That forces every funding-only integrator to write a meaningless pass-through plugin.

### Type changes

```ts
export interface FundingIntent {
  // ...unchanged fields
  action?: DestinationActionRequest;
}

export interface IntentQuote {
  id: string;
  intent: FundingIntent;
  funding: FundingQuote;
  action: DestinationActionQuote | null;
  expiresAt: string;
  totalEtaSeconds: number;
}

export interface RailClientOptions {
  fundingProviders: FundingProviderPlugin[];
  destinationActions?: DestinationActionPlugin[];
  settlementVerifier?: SettlementVerifier;
  now?: () => number;
}
```

### Behaviour changes

**Constructor.** Drop the `NO_DESTINATION_ACTIONS` throw. `NO_FUNDING_PROVIDERS` stays: a rail with no funding provider is meaningless.

**`quote()`.** Resolve the action plugin only when `intent.action` is present. A named-but-unregistered plugin still throws `ACTION_PLUGIN_NOT_FOUND`; that is a configuration error, not a funding-only intent. When absent, skip the action stage and build:

```ts
{
  id: `${provider.manifest.id}:${draft.id}`,
  intent, funding, action: null,
  expiresAt: funding.expiresAt,
  totalEtaSeconds: funding.etaSeconds,
}
```

**Ranking.** Introduce two helpers and use them in `compareQuotes` and the `INCOMPARABLE_OUTPUT` check:

```ts
const rankingAmount = (q: IntentQuote) =>
  q.action?.minimumOutput ?? q.funding.minimumOutput;
const rankingAsset = (q: IntentQuote) => rankingAmount(q).asset;
```

Mixed-shape batches are impossible: action presence is a property of the intent, which is shared by every quote in a batch. No quote can be ranked against one of a different shape.

**Action methods.** `refreshActionQuote`, `prepareAction`, and `getActionStatus` throw `ACTION_NOT_CONFIGURED` when `quote.action` is null.

**Flow.** In `refreshFunding`, a completed funding status transitions to `destination-ready` when the intent has an action, and directly to `completed` when it does not. `completed` therefore always means the user received what they asked for. `prepareAction`, `markActionSubmitted`, and `refreshAction` throw `ACTION_NOT_CONFIGURED` on funding-only flows.

**Validation.** `validateIntent` treats `action` as optional and, when present, requires a non-empty `pluginId`.

---

## 4. Resumable flow

### Rationale

`PRODUCT_VISION_AND_MVP.md` §7 requires that references persist outside modal state, and the beta capability list requires resuming settlement tracking after refresh. Neither exists. `RailFlow` has no serialization, and `refreshFunding()` throws unless the phase is exactly `funding-pending`, which only `markFundingSubmitted()` can set. After a browser refresh a user's in-flight transfer is unreachable through the SDK by construction.

### API

```ts
export interface PersistedRailFlow {
  version: 1;
  persistedAt: string;
  snapshot: RailFlowSnapshot;
}

// RailFlow
serialize(): PersistedRailFlow;

// RailClient
hydrateFlow(persisted: PersistedRailFlow): RailFlow;
```

`RailFlowSnapshot` is already JSON-safe, so serialization is a structural copy plus a version envelope. Hydration lives on `RailClient` because rehydration must resolve plugins.

### Rehydration rules

| Persisted phase | Result | Reason |
|---|---|---|
| `funding-pending` | restored | A submitted source transaction is the exact case resume exists for |
| `destination-ready` | restored | Funding settled; the action can still be prepared |
| `action-pending` | restored | A submitted destination transaction can still be confirmed |
| `completed`, `refunded`, `failed` | restored | Terminal; useful for receipts and support |
| `quote-ready` | restored if the quote is still fresh, else `idle` | A stale quote must never be signed |
| `quoting`, `preparing-funding`, `preparing-action` | `idle` | An in-flight request cannot be resumed |
| `awaiting-source-signature`, `awaiting-destination-signature` | `quote-ready` if fresh, else `idle` | The held wallet steps are stale |

> **Superseded 2026-08-04.** The two rows above were an oversight for the post-settlement phases: `preparing-action` and `awaiting-destination-signature` are only reachable after funding settled, so degrading them past `destination-ready` erased the funding evidence and re-armed payment. They now restore as `destination-ready` with the funding record intact, and `preparing-funding` degrades to `quote-ready` while its quote is fresh. `docs/ARCHITECTURE.md` is the living description of the restore contract.

Failure modes, all fail-closed:

- `UNSUPPORTED_PERSISTED_VERSION` when `version !== 1`.
- `FUNDING_PLUGIN_NOT_FOUND` / `ACTION_PLUGIN_NOT_FOUND` when a referenced plugin is no longer registered.
- `INVALID_PERSISTED_SNAPSHOT` when the snapshot fails the same validation applied to live state.

**Wallet steps are always dropped on rehydrate** and must be re-prepared. Unsigned transactions carry stale Solana blockhashes and TRON reference blocks; restoring one would let a user sign an expired or replayable request. This is a safety property, not an optimisation.

Quote expiry is enforced only before funding submission. Past `funding-pending`, funding is already irreversible and the action quote is refreshed by `prepareAction` regardless.

### Known limitation

If a user approves in their wallet and the tab dies before `markFundingSubmitted`, the SDK cannot recover the reference. No SDK-side design fixes this. The mitigation is a documented host obligation to persist immediately on submission, which the reference app demonstrates.

---

## 5. Settlement verification

### Rationale

`refreshActionQuote` tightens the destination action to the true received amount only when `FundingStatus.received` is non-null. The LayerZero adapter deliberately leaves it null because the provider's status API does not prove the destination balance delta. The result: on every route today, including a future CCTP one, the destination action is sized from the *quoted minimum*, and §11 protection 12 ("independently verify the received destination asset and amount") is unimplemented. This is the gap that most weakens the "guaranteed final output" claim.

### Core interface

```ts
export interface SettlementVerifier {
  verify(
    request: { intent: FundingIntent; quote: FundingQuote; status: FundingStatus },
    context: PluginContext,
  ): Promise<AssetAmount | null>;
}
```

Registered through `RailClientOptions.settlementVerifier`. In `getFundingStatus`, after existing validation:

1. Run only when `state === "completed"`, `received === null`, and `destinationReference !== null`.
2. A returned amount whose asset differs from `quote.minimumOutput.asset` throws `SETTLEMENT_ASSET_MISMATCH`.
3. **A returned amount below `quote.minimumOutput` throws `SETTLEMENT_BELOW_MINIMUM`.** This is the point of verifying and cannot currently happen on any route.
4. `null` leaves `received` null and preserves today's quoted-minimum fallback, so the verifier is strictly additive.
5. A spliced status is re-run through `validateFundingStatus` before being returned, so a verifier cannot introduce a status the core would have rejected from a provider.

### `@hedgents/stablecoin-rail-solana`

Dependencies: `@noble/hashes` and `@noble/curves`, both small and audited. `@noble/curves` is not optional: associated-token-account derivation must reject on-curve candidate addresses, which needs ed25519 point decoding. Skipping that check silently yields a wrong address for roughly one owner and mint pair in 256, which is unacceptable for a money path.

```ts
createSolanaSettlementVerifier(options: {
  rpcUrl: string;
  commitment?: "confirmed" | "finalized";
  fetch?: typeof globalThis.fetch;
}): SettlementVerifier;

// pure helpers, no I/O
decodeBase58(value: string): Uint8Array;
encodeBase58(bytes: Uint8Array): string;
deriveAssociatedTokenAddress(owner: string, mint: string, tokenProgram?: string): string;
toBytes32(address: string): `0x${string}`;
```

The verifier calls `getTransaction` with `maxSupportedTransactionVersion: 0`, reads `meta.preTokenBalances` and `meta.postTokenBalances`, matches the entry whose `owner` equals the destination wallet and whose `mint` equals the settlement asset, and returns the delta. It also checks the reported `programId` so classic SPL Token and Token-2022 are distinguished, satisfying §11 protection 11. A missing, failed, or unmatched transaction returns `null` rather than throwing, so an indexing lag degrades to today's behaviour instead of breaking the flow.

One implementation serves LayerZero, CCTP, and every future Solana route.

---

## 6. Generic CCTP funding provider

### Configuration

Source chains are configuration, not code, so Ethereum, Base, Arbitrum, and any other CCTP domain are entries rather than new packages.

```ts
export interface CctpSourceChain {
  chainId: string;              // CAIP-2, e.g. "eip155:1"
  numericChainId: number;
  cctpDomain: number;
  usdcAddress: `0x${string}`;
  tokenMessengerV2: `0x${string}`;
}

createCctpToSolana(options: {
  sources: CctpSourceChain[];
  solana: { chainId: string; usdcMint: string; cctpDomain: number };
  apiBaseUrl?: string;          // default https://iris-api.circle.com
  fetch?: typeof globalThis.fetch;
}): FundingProviderPlugin;
```

### Plugin behaviour

**`supports`** requires the source chain to be configured, the source asset to be that chain's USDC, the destination to be the configured Solana chain, and the settlement asset to be the configured USDC mint.

**`quote`** derives the destination associated token account, checks its existence over RPC to decide whether recipient setup is needed, requests the Iris v2 fee schedule for the domain pair, selects the fast tier with a first-tier fallback, computes protocol plus forward fee, and sets `minimumOutput = amount - maxFee`. It rejects amounts that do not clear the fee plus a safety buffer.

**`prepare`** returns two EVM steps, both with `value: "0"`:

1. An **exact-amount** ERC-20 approval to `tokenMessengerV2`. Never unlimited, per §11 protection 5.
2. `depositForBurnWithHook` with the pinned mint recipient, destination domain, max fee, finality threshold, and forwarding hook data.

**`getStatus`** polls Iris messages by source transaction hash, maps attestation state to the rail's `pending` / `completed` / `failed` / `refunded` model, and surfaces the Solana delivery transaction as `destinationReference`, which feeds the verifier from section 5.

### Encoding

A hand-rolled encoder covering exactly two signatures, roughly sixty lines, with fixture tests asserting byte-exact output against known vectors. This keeps the package dependency-free and the security-review surface small. Circle's current API shapes will be re-verified against their documentation before implementation rather than assumed; the fee schedule format is the fragile part.

---

## 7. Conformance suite and reference application

### `@hedgents/stablecoin-rail/testing`

Runner-agnostic so provider authors are not forced onto `node --test`:

```ts
export interface ConformanceCase {
  name: string;
  run(): Promise<void>;
}

export function fundingProviderConformance(setup: {
  plugin: FundingProviderPlugin;
  supportedIntent: FundingIntent;
  unsupportedIntent: FundingIntent;
  now?: () => number;
}): ConformanceCase[];

export function destinationActionConformance(setup: {
  plugin: DestinationActionPlugin;
  intent: FundingIntent;
  fundingQuote: FundingQuote;
  unsupportedFundingQuote: FundingQuote;
  now?: () => number;
}): ConformanceCase[];
```

Exposed as a `./testing` subpath export in the core package manifest, so it is importable without being part of the main entry point.

Cases assert the contract the core relies on: `supports` rejects foreign intents; `quote` returns `null` rather than throwing for unsupported routes; quoted amounts match the intent exactly; `minimumOutput` never exceeds `expectedOutput`; `executionMode` is `two-phase`; expiry is a valid future ISO timestamp; `prepare` fails on a pin mismatch; `getStatus` rejects a reference from the wrong chain.

This turns the plugin contract from prose into something enforceable, which is both an adoption argument and a grant argument.

### `examples/reference-app`

Vite plus React, deliberately not Next, so adopters are not forced into a framework. Contents: a small Node server holding the LayerZero key so it never reaches the browser, TronLink and Solana Wallet Standard connectors, `localStorage` persistence wired to `serialize` and `hydrateFlow` so resume is demonstrated rather than described, both routes configured, and a funding-only toggle exercising section 3.

This is also the harness that executes the mainnet proof once credentials exist.

---

## 8. TRON activation checklist

Shipped as `docs/ACTIVATION_TRON.md`. Ordered, and every step must pass before the route loses its gate.

1. Obtain a LayerZero production API key and configure it server-side. Confirm it never appears in a client bundle.
2. Obtain the official current USDT0 Legacy Mesh contract and recipient set for third-party integrators. Record the source and retrieval date.
3. Implement `validateTronTransaction` against that allowlist. Preparation already fails closed without it.
4. Verify the decoded TRC-20 call: recipient, amount, `fee_limit` ceiling, owner in both Base58Check and hexadecimal form.
5. Fund a TRON wallet with the smallest viable USDT amount plus TRX for energy and bandwidth. Record the energy actually consumed.
6. Execute one transfer through the reference app. Record the source transaction, provider status transitions, delivery transaction, wall-clock latency, and fees.
7. Confirm the Solana verifier reports a balance delta at or above the quoted minimum.
8. Repeat once with a deliberately induced failure or refund and record the recovery path.
9. Only then change the route matrix status from Gated to Implemented, citing the transaction hashes.

The route matrix in `PRODUCT_VISION_AND_MVP.md` §8 is updated in the same change so no route is marked Implemented before it has moved real value.

---

## 9. Test plan

Continue with `node --test`, no framework.

- **Core, optional action:** funding-only quoting with no registered action; ranking across funding-only quotes; `ACTION_NOT_CONFIGURED` from all four action entry points; a named-but-unregistered plugin still throwing.
- **Core, resume:** round-trip serialize and hydrate for each resumable phase; every degradation row in the section 4 table; version mismatch; missing plugin; wallet steps confirmed absent after hydrate.
- **Core, verification:** verifier invoked only under the stated conditions; `SETTLEMENT_BELOW_MINIMUM` on a short delivery; `SETTLEMENT_ASSET_MISMATCH` on a foreign asset; `null` preserving current behaviour.
- **`-solana`:** base58 round-trip; ATA derivation golden vectors against known mainnet addresses; balance-delta extraction from recorded RPC fixtures including a Token-2022 case; unmatched transaction returning `null`.
- **`-cctp`:** byte-exact encoder fixtures for both signatures; fee-tier selection including fallback; too-small amount rejection; approval amount is exact, never unlimited; status mapping from recorded Iris fixtures.
- **Conformance:** both existing providers pass their own suite.

All network interaction is tested against recorded fixtures. No test requires credentials or hits a live endpoint.

---

## 10. Risks

| Risk | Handling |
|---|---|
| Circle's fee schedule or endpoint shape differs from the current implementation reference | Re-verify against Circle documentation before implementing; fixtures pinned to a dated response |
| Hand-rolled ABI encoding is wrong | Byte-exact golden vectors; the two signatures are static except for one `bytes` field |
| USDT0 target set migrates after we pin an allowlist | Already mitigated: the allowlist is a host-supplied policy hook, not a hardcoded constant |
| LayerZero returns multiple or non-`TRANSACTION` wallet steps in production | Adapter already fails closed on unsupported step types; the reference app must render multi-step flows |
| Optional action is a breaking change for any existing consumer | Version as `0.2.0`; nothing is published yet, so blast radius is zero |
| Scope creep from the conformance suite | Limited to the contract assertions listed in section 7 |

## 11. Out of scope

- Any change to `frontend/`.
- Publishing to npm. That needs the npm scope, provenance setup, and the independent security review.
- The TRON mainnet proof itself, pending credentials and funded wallets.
- Marking any route Implemented before real value has moved.
- USDG routes and Hyperliquid funding. Deferred until the CCTP and Mayan providers are proven.
- A hosted Hedgents control plane. `core/remote` gives adopters the server half; running one as a service is a separate product decision.
