# Solana Foundation grant brief

**Working title:** Open Stablecoin Ingress for Solana Applications
**Funding path:** Standard milestone-based public-good grant
**Suggested request:** $40,000 over 12 weeks
**Licence:** Apache-2.0
**Repository:** https://github.com/Hedgents/stablecoin-rail

## Application overview

Hedgents Stablecoin Rail is an open-source, non-custodial SDK that lets Solana applications accept major stablecoins from external chains through one safety contract. Applications integrate one state machine for route discovery, exact asset identity, minimum delivery, unsigned wallet requests, server-side provider credentials, settlement evidence, refunds, recovery, and an optional Solana destination action.

The SDK does not create a bridge, hold keys, or operate a solver. Circle CCTP, LayerZero OFT routes, and intent providers remain responsible for transport. The public good is the reusable integration and verification layer that prevents every Solana application from rebuilding the same failure-prone funding flow.

USDC over CCTP is the first proven provider, not the scope of the product. The core is stablecoin- and provider-neutral. USDT over USDT0/LayerZero, USDG over LayerZero OFT, and a disclosed Binance-Peg USDC adapter already implement the same contract; the non-USDC routes remain gated pending credentials or mainnet proofs.

## The problem for Solana builders

Solana applications can serve users only after capital reaches Solana. External stablecoin liquidity is fragmented by issuer, chain, wallet namespace, transport provider, signing format, status API, and refund behavior. Today each application must independently decide whether two tokens with the same ticker are actually the same asset, protect provider credentials, validate wallet calls, recover interrupted transfers, attribute destination settlement, and avoid spending an optimistic quote before funds arrive.

Those are security boundaries, not interface polish. A false asset match, stale wallet request, unrelated balance increase, or lost in-flight reference can cause a short delivery, duplicate payment, or irreversible transfer to the wrong target.

Stablecoin Rail makes those boundaries executable and testable once for the ecosystem.

## Public-good contribution

The grant output will remain available under Apache-2.0:

- a provider-neutral funding and destination-action contract;
- an executable conformance suite for provider and action plugins;
- exact Solana settlement verification for SPL Token and Token-2022 assets;
- public adapters for major canonical stablecoins;
- reproducible mainnet evidence with fees, latency, transaction links, and failure notes;
- reference Jupiter and lending/deposit destination actions;
- integration guides, threat models, and an independent security report.

The core has zero runtime dependencies. Provider packages remain separable, so applications install only the trust boundaries they choose.

## Why Solana

The transport leg is cross-chain; the settlement and application outcome are Solana-specific. The SDK derives and validates Solana token accounts, checks token-program ownership, attributes balance changes to exact Solana transactions, preserves Token versus Token-2022 distinctions, and refreshes a destination action from the amount actually received.

The result is not merely “tokens reached a destination chain.” It is “a verified amount of a specific canonical asset is available to a specific Solana application action.” That boundary can support swaps, lending deposits, payments, vaults, mints, subscriptions, and other Solana products without giving a bridge custody over the application step.

The grant scope is deliberately not “build another cross-chain wrapper.” The provider-neutral core already exists and is open source. Grant funds are directed to Solana-specific public infrastructure: Token and Token-2022 verification, exact Solana transaction attribution, unsigned Solana wallet requests, destination-action safety, and integrations with Solana protocols. An endpoint for another chain would require a different verifier, account model, transaction policy, and application-action layer; those are outside these milestones.

## Difference from existing tools

Circle Bridge Kit simplifies USDC movement over CCTP. Bridge aggregators select transport routes. Stablecoin Rail sits above both categories:

| Capability | Single-provider bridge SDK | Bridge aggregator | Stablecoin Rail |
|---|---:|---:|---:|
| Multiple stablecoin families | No | Sometimes | Yes, with exact asset policies |
| Provider-neutral plugin contract | No | Internal | Public and executable |
| Exact Solana settlement evidence | Provider-specific | Provider-specific | Required by contract |
| Crash-safe resumability | Provider-specific | UI-specific | Core state machine |
| Server/browser credential boundary | Provider-specific | Hosted service | Open remote transport |
| Rank final Solana application output | No | No | Yes |
| Public plugin conformance suite | No | No | Yes |

The SDK rejects hidden stablecoin swaps by default. Routes crossing an issuer boundary must identify that boundary in the quote instead of presenting a shared ticker as equivalence.

## Current evidence

- Seven public npm packages with provenance attestations.
- 226 deterministic tests covering the core, Solana verification, provider conformance, CCTP, LayerZero, Mayan, liquidity assessment, and React recovery.
- Strict TypeScript builds and package dry-runs in public CI.
- One 5 USDC Ethereum → Solana CCTP V2 mainnet transfer:
  - [source burn](https://etherscan.io/tx/0x509ce416c0fd1908053e39221e1c1e157a4e52324514882296fbf194df5152f1)
  - [Circle message and forwarding evidence](https://iris-api.circle.com/v2/messages/0?transactionHash=0x509ce416c0fd1908053e39221e1c1e157a4e52324514882296fbf194df5152f1)
  - [Solana delivery](https://solscan.io/tx/KwTk3nn76FWS1CtmtEHbVJsURJNLvBAdJ7jhGqqj2Mr8qHCHasVYrdeC3e4gnx1QELX1pJkUxUxK8s8JDpX3rqw)
- A read-only `npm run verify:cctp-proof` command that replays the public evidence through the current exact-transaction verifier and confirms 4.875317 USDC received.

The project remains alpha. Only the Ethereum CCTP route has a mainnet proof, and there has been no independent security review.

## Milestones and use of funds

### M1 — Public stablecoin route standard — $6,000 — weeks 1–2

Publish version 1 of the route-risk schema and conformance contract covering exact asset identity, canonical versus adapter routes, minimum output, transaction target pins, settlement evidence, refunds, and recovery.

**Acceptance:** versioned specification; executable conformance cases; CCTP, LayerZero, and Mayan packages passing the same public suite; threat model published.

### M2 — Solana settlement verifier — $8,000 — weeks 2–5

Harden the Solana package around `@solana/kit`, SPL Token and Token-2022 ownership, exact transaction attribution, RPC failure behavior, and recorded mainnet fixtures.

**Acceptance:** typed public API; Token and Token-2022 test matrices; exact-credit verification; read-only integration harness; no wallet or signing dependency in the verifier.

### M3 — Major stablecoin routes — $10,000 — weeks 4–8

Productionize and prove one canonical USDT route and one canonical USDG route in addition to USDC. Record fees, latency, minimums, destination evidence, and recovery behavior.

**Acceptance:** at least three stablecoin families represented by public packages; one mainnet proof per enabled family; explicit issuer and transformation metadata; production routes disabled automatically when required credentials or allowlists are absent.

### M4 — Solana destination actions — $8,000 — weeks 7–10

Ship reference Jupiter and lending/deposit action packages that consume only the amount verified after settlement, refresh expired quotes, expose unsigned Solana wallet requests, and verify the final application outcome.

**Acceptance:** two public action packages; simulations and account-owner checks; funding-plus-action reference application; recovery when an action becomes unavailable after funding.

### M5 — Independent review and adoption — $8,000 — weeks 9–12

Commission an independent review of the core contracts and first-party adapters, resolve confirmed findings, and support two external Solana applications through integration.

**Acceptance:** public review report and remediation log; two integrations outside the SDK repository; published integration notes; final route matrix and maintenance policy.

## Success measures

- three canonical stablecoin families supported by production-shaped public adapters;
- one reproducible mainnet proof for every production-enabled route;
- two external Solana applications integrated;
- every first-party provider and action passing the public conformance suite;
- no provider credential shipped to a browser bundle;
- every completed flow carrying an exact Solana destination transaction and measured amount;
- independent findings published with remediation status.

## Dependencies and fallback plan

The USDT and USDG adapters currently depend on a LayerZero Value Transfer API key. This does not block the public contract, Solana verifier, CCTP route, destination actions, or conformance work. If production credentials are delayed beyond M3, the milestone will validate another permissionless canonical stablecoin route and keep LayerZero adapters gated rather than weaken their security policy.

No milestone requires Hedgents to operate a bridge, validator, relayer, or custodial service.

## Long-term maintenance

Hedgents will maintain the public packages, provider presets, security advisories, and compatibility tests. Any future hosted control plane or commercial service will remain outside the grant deliverables; the SDK, specifications, fixtures, adapters, and review outputs funded here remain open source and independently usable.
