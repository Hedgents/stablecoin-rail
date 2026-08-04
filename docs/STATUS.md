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

## Current status: alpha, and no route has moved real money

**Nothing here has completed a mainnet transfer.** Quoting has been exercised against live Circle, Mayan, LayerZero, Allbridge, and Solana endpoints. Signing has not been exercised at all. There has been no independent security review.

Treat this as a working demonstration of a design, not as production infrastructure.

### Routes

| Route | Provider | Asset integrity | State |
|---|---|---|---|
| Ethereum USDC → Solana USDC | Circle CCTP V2 | native, like-for-like | Implemented, unproven on mainnet |
| Base USDC → Solana USDC | Circle CCTP V2 | native, like-for-like | Implemented, unproven on mainnet |
| Arbitrum USDC → Solana USDC | Circle CCTP V2 | native, like-for-like | Implemented, unproven on mainnet |
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
- Resume across a page reload, with unsigned wallet steps deliberately discarded rather than restored
- Settlement verification that stops a flow when less arrives than was guaranteed
- A remote transport keeping provider credentials server-side, proven contract-preserving by running the same conformance suite through it
- An executable plugin conformance suite that every shipped provider passes
- Pool-depth and liquidity-risk assessment for pool-based routes

### What is not built

- No transfer execution for Allbridge (liquidity assessment only)
- No destination-action package; Jupiter exists only as a boundary example
- No hosted control plane
- No USDG route from Ethereum, no Hyperliquid funding

### Known limitations, stated rather than buried

- **Settlement verification has never run against a real delivery.** It is tested only against recorded RPC fixtures.
- **Circle exposes no destination-transaction identifier** for a forwarded transfer, so the CCTP route proves delivery by destination balance and cannot report an exact received amount.
- **Mayan reports amounts as JavaScript numbers**, so amounts far above ~1e9 units cannot be converted exactly. That is a limitation of an API that sends money as a float.
- **A wallet approval lost before `markFundingSubmitted`** cannot be recovered by any SDK-side design. Hosts must persist the reference at submission time.
- **The TRON contract allowlist is optional hardening**, not a precondition. A production deployment should configure one; USDT0 migrates Legacy Mesh contracts wholesale.

---

## Before anyone uses this for real money

1. A small-value mainnet transfer on each enabled route, with fees, latency, and refund behaviour recorded
2. An independent security review of the plugin contracts and every provider adapter
3. Rate limiting, order-size caps, and jurisdiction policy at the host layer. The SDK deliberately ships none of these, because it cannot know your rules and a token gesture would invite integrators to assume protection they do not have
4. A configured USDT0 contract allowlist for the TRON route

## Testing

184 tests, no network I/O; every upstream response is a recorded fixture. Provider adapters are additionally checked against the shared conformance suite, so a plugin cannot pass on its own test doubles alone.

```bash
npm install && npm test
```

## Licence

Apache-2.0
