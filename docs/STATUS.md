# What this is, and where it actually stands

**Last updated:** 2026-08-04

This document exists so nobody has to infer the maturity of this project from its commit count. It says plainly what works, what is untested, and what is not built.

---

## What we are making

A **non-custodial SDK for bringing stablecoins from other chains into a Solana application**, and a reference bridge built on it.

The problem it addresses is not transport. Circle, LayerZero, and Mayan already move tokens perfectly well. The problem is that every Solana application wanting external capital re-solves the same set of unglamorous concerns: discovering executable routes, keeping provider credentials out of the browser, pinning exact asset identities, constructing wallet requests, tracking settlement and refunds, resuming interrupted sessions, and preserving custody when the destination step cannot run.

This turns those into a plugin contract.

### What makes it different from a bridge aggregator

A bridge aggregator's job ends when tokens land. This ranks the **guaranteed final application outcome**, then optionally continues into a destination action such as a swap or deposit. The cheapest bridge is frequently not the best route once fees, settlement minimums, and the refreshed destination quote are accounted for.

### Principles it actually enforces in code

- **A stablecoin family does not change underneath the user.** Quotes containing a swap step are rejected by default. Where a route genuinely crosses an issuer boundary (Binance-Peg USDC on BNB), it is named as an adapter route and carries a disclosure string in every quote.
- **Never signs.** Plugins return unsigned wallet requests. The SDK has no access to wallets and deliberately provides no `signAndSend`.
- **Honest atomicity.** Only `two-phase` quotes are accepted. The destination action is re-quoted from the *confirmed* received amount, and a test asserts it fails closed if quoted from an optimistic one.
- **Fail closed.** An expired quote, a changed signer, an unexpected contract, a missing delivery proof, or an ambiguous output stops execution.
- **Verified, not assumed.** A delivery is not complete because a provider said `SUCCEEDED`. It is complete when the destination chain shows it.

---

## Current status: alpha, with one route proven on mainnet

**Ethereum USDC to Solana USDC has completed a real mainnet transfer.** Everything else remains unproven, and there has been no independent security review.

An internal adversarial audit (2026-08-04, thirty independent review passes with every finding attacked by a separate verifier) confirmed 12 real defects: one critical (crash-recovery could erase a settled transfer's record and invite a double payment), four high (a provider self-report below the guaranteed minimum bypassed verification; a transient RPC or status-API error terminally failed in-flight flows; an RPC error at quote time zeroed the delivery baseline; balance-delta completion was not attributable to the transfer). All 12 are fixed with regression tests. Internal is not independent; the review in the list below still stands open.

### The proof

| | |
|---|---|
| Route | Ethereum USDC → Solana USDC, Circle CCTP V2 |
| Sent | 5.000000 USDC |
| Guaranteed | 4.875317 USDC |
| Source transaction | [Ethereum burn `0x509c…52f1`](https://etherscan.io/tx/0x509ce416c0fd1908053e39221e1c1e157a4e52324514882296fbf194df5152f1) |
| Circle attestation | [`complete`, domain 0 → 5](https://iris-api.circle.com/v2/messages/0?transactionHash=0x509ce416c0fd1908053e39221e1c1e157a4e52324514882296fbf194df5152f1) |
| Solana delivery | [`KwTk…3rqw`](https://solscan.io/tx/KwTk3nn76FWS1CtmtEHbVJsURJNLvBAdJ7jhGqqj2Mr8qHCHasVYrdeC3e4gnx1QELX1pJkUxUxK8s8JDpX3rqw) |
| Destination wallet | [`FtXS…1vP7B`](https://solscan.io/account/FtXSmydZCxEu78tr2sTcbSNByGPENZu7wNJNMhz1vP7B) |
| Cost | 0.124183 forwarding, 0.000500 protocol |

Independently verified after the fact against Circle's message API and the destination token account, not merely reported by the interface that performed it.

### What that transfer does and does not prove

It proves the full path end to end: quote, exact-amount approval, `depositForBurnWithHook`, Circle's Forwarding Service delivering on Solana, and **completion detected on the destination chain** rather than by a provider claiming success.

One honesty note: the original transfer exercised the completion mechanism of its day, a balance-versus-baseline comparison. A subsequent audit showed that mechanism could be satisfied by an unrelated deposit and starved by an unrelated spend. It has been replaced with exact attribution: the provider follows Circle's `forwardTxHash`, reads that Solana transaction, requires a configured CCTP program, and measures the owner-and-mint credit. `npm run verify:cctp-proof` replayed the public transfer through that current code path and recovered the exact 4.875317 USDC delivery.

It does not prove Base, Arbitrum, or Monad, which share the code path but have not been exercised. It does not prove the Mayan or LayerZero routes at all. It does not prove refund handling, and it does not prove resume across a genuine mid-transfer reload.

The forwarding fee is flat rather than proportional: the same 0.124 USDC applies at 5 USDC or 500, so the ~2.5% observed on a 5 USDC transfer is an artefact of the test size.

Treat this as a working demonstration of a design with one route validated, not as production infrastructure.

### Routes

| Route | Provider | Asset integrity | State |
|---|---|---|---|
| Ethereum USDC → Solana USDC | Circle CCTP V2 | native, like-for-like | **Proven on mainnet** |
| Base USDC → Solana USDC | Circle CCTP V2 | native, like-for-like | Implemented, same code path as the proven route, unexercised |
| Arbitrum USDC → Solana USDC | Circle CCTP V2 | native, like-for-like | Implemented, same code path as the proven route, unexercised |
| Monad USDC → Solana USDC | Circle CCTP V2 | native, like-for-like | Implemented, same code path as the proven route, unexercised |
| BNB Binance-Peg USDC → Solana USDC | Mayan | **issuer boundary, swap** | Implemented, unproven on mainnet |
| TRON USDT → Solana USDT | USDT0 / LayerZero | canonical, like-for-like | Implemented, needs an API key |
| Robinhood USDG → Solana USDG | LayerZero OFT | canonical, like-for-like | Implemented, needs an API key |

Both LayerZero routes are gated on a single `LAYERZERO_API_KEY`. Everything else is configuration.

### Packages

| Package | Purpose |
|---|---|
| `@hedgents/stablecoin-rail` | Contracts, ranking, validation, flow state machine, remote transport, conformance suite. **Zero runtime dependencies.** |
| `@hedgents/stablecoin-rail-solana` | Base58, associated-token-account derivation, settlement verification |
| `@hedgents/stablecoin-rail-cctp` | Circle CCTP V2, source chains as configuration |
| `@hedgents/stablecoin-rail-mayan` | Binance-Peg USDC adapter route, vendor SDK injected |
| `@hedgents/stablecoin-rail-layerzero` | USDT0 TRON and USDG Robinhood routes |
| `@hedgents/stablecoin-rail-allbridge` | Pool-liquidity assessment (no transfers) |
| `@hedgents/stablecoin-rail-react` | `useRailFlow`, including resume |

### What works today

- Funding-only intents, so the rail can be adopted purely to land a stablecoin in a wallet
- Route ranking by guaranteed output across providers
- Resume across a page reload, with unsigned wallet steps deliberately discarded rather than restored, and settled-funding evidence preserved so a crash after settlement can never re-arm payment
- Settlement verification that stops a flow when less arrives than was guaranteed, applied equally to provider self-reports
- Transient RPC or status-API failures during polling surface as retryable errors instead of terminally failing a flow whose funds are in flight
- A remote transport keeping provider credentials server-side, proven contract-preserving by running the same conformance suite through it
- An executable plugin conformance suite that every shipped provider passes
- Pool-depth and liquidity-risk assessment for pool-based routes

### What is not built

- No transfer execution for Allbridge (liquidity assessment only)
- No destination-action package; Jupiter exists only as a boundary example
- No hosted control plane
- No USDG route from Ethereum, no Hyperliquid funding

### Known limitations, stated rather than buried

- **Settlement verification has now run against one real delivery**, on the Ethereum route. Every other route's verification is still exercised only against recorded fixtures.
- **Current Circle CCTP V2 responses expose `forwardTxHash`,** which the provider treats as the exact destination transaction and verifies independently on Solana. A bounded recipient-account scan remains only as a compatibility path for older or recorded responses that omit the field; the concurrent same-size ambiguity applies only to that fallback.
- **Mayan completion is still a balance-versus-baseline check**, not an attributed delivery transaction. An unrelated deposit clearing the minimum between quote and delivery would satisfy it, and a spend from the account after quoting can delay it past the actual delivery. The CCTP route no longer has this property; the Mayan route does.
- **Mayan reports amounts as JavaScript numbers**, so amounts far above ~1e9 units cannot be converted exactly. That is a limitation of an API that sends money as a float.
- **The reference demo's optional Mayan SDK currently brings four moderate npm audit advisories** through `@solana/web3.js` → `jayson` → `uuid`; npm reports no fixed upstream release. No `@hedgents` package bundles that SDK—the host injects it—but the demo should not be deployed unchanged.
- **A wallet approval lost before `markFundingSubmitted`** cannot be recovered by any SDK-side design. Hosts must persist the reference at submission time.
- **The TRON contract allowlist is optional hardening**, not a precondition. A production deployment should configure one; USDT0 migrates Legacy Mesh contracts wholesale.

---

## Before anyone uses this for real money

1. A small-value mainnet transfer on **each remaining** route, with fees, latency, and refund behaviour recorded. Ethereum is done; Base, Arbitrum, Monad, BNB, TRON, and Robinhood are not
2. An independent security review of the plugin contracts and every provider adapter
3. Rate limiting, order-size caps, and jurisdiction policy at the host layer. The SDK deliberately ships none of these, because it cannot know your rules and a token gesture would invite integrators to assume protection they do not have
4. A configured USDT0 contract allowlist for the TRON route

## Testing

226 tests, no network I/O; every upstream response is a recorded fixture. Provider adapters are additionally checked against the shared conformance suite, so a plugin cannot pass on its own test doubles alone.

```bash
npm install && npm test
```

The separate `npm run verify:cctp-proof` command performs a read-only live replay against Circle and Solana. It is intentionally not part of the deterministic unit suite.

### Verifying the published packages

`scripts/verify-published.mjs` installs the **published** packages from npm into a throwaway directory outside this workspace and exercises them against live endpoints.

That distinction matters. Consuming them from inside the monorepo proves nothing, because npm workspaces link the local folder whenever its version satisfies the range, so a missing file or a broken `exports` map would still resolve locally and break only for an actual installer.

```bash
node scripts/verify-published.mjs alpha
```

It also runs weekly in CI. Last clean-room result: all twelve checks passing, including a live Base quote returning 9.87706 USDC guaranteed from 10 USDC in.

## Licence

Apache-2.0
