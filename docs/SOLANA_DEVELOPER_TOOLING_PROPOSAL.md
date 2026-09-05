# Developer Tooling Grant Proposal

Solana Foundation application

## 1. Applicant Information

### Project / Tool Name

Hedgents Stablecoin Rail — Open Stablecoin Ingress for Solana Applications

### Applicant / Organization

Hedgents

### Primary Contact (name, email, Telegram/X)

**SUBMISSION INPUT REQUIRED:** Name — email — Telegram or X handle

### Total Amount Requested (USD)

$40,000

### Relevant Experience & Track Record

Hedgents has already delivered the working alpha that this proposal extends. The public monorepo contains seven published npm packages with provenance attestations: a zero-runtime-dependency core, Solana settlement utilities, provider adapters for Circle CCTP, LayerZero, and Mayan, an Allbridge liquidity assessor, and React bindings. The repository currently passes 226 deterministic tests, strict TypeScript builds, package dry-runs, and a separately built reference application in public CI.

The team has completed a real 5 USDC Ethereum-to-Solana CCTP V2 transfer and published the source transaction, Circle message, exact Solana delivery transaction, fees, and destination amount. A read-only command replays this evidence through the current verifier and confirms the exact 4.875317 USDC credit. An internal adversarial review found and remediated twelve defects, including crash-recovery, transient-RPC, minimum-delivery, and transaction-attribution failures; each confirmed issue has a regression test. The project states clearly that this internal work is not an independent security review.

Repository: [GitHub monorepo](https://github.com/Hedgents/stablecoin-rail)

Project status and mainnet evidence: [current status and proof](https://github.com/Hedgents/stablecoin-rail/blob/main/docs/STATUS.md)

Published package: [core npm package](https://www.npmjs.com/package/@hedgents/stablecoin-rail)

**SUBMISSION INPUT REQUIRED:** Add two or three links showing the applicant's prior shipped software, documentation, or Solana ecosystem work outside this repository. The current proposal does not invent experience that has not been supplied.

## 2. Overview of Ecosystem Impact

### How is this project a public good for the Solana community?

Stablecoin Rail is an Apache-2.0, non-custodial SDK that lets Solana applications accept canonical stablecoins from external chains through one reusable safety contract. It does not create or operate a bridge, hold keys, issue a token, or require a Hedgents-hosted service. Circle CCTP, LayerZero OFT routes, and intent providers remain responsible for transport. The public-good contribution is the open integration and verification layer between those transports and Solana applications.

Without a shared layer, every application independently rebuilds the same security-sensitive workflow: exact asset identification, route comparison, provider credential isolation, wallet-request validation, settlement attribution, minimum-delivery enforcement, crash recovery, refunds, and optional post-settlement actions. A ticker match, provider success response, or wallet balance increase is not sufficient evidence that the intended transfer delivered the intended asset. Reimplementing these boundaries per application creates duplicated work and repeated opportunities for loss.

The grant-funded outputs will remain independently usable under Apache-2.0: versioned route and risk schemas, an executable provider conformance suite, exact Solana settlement verification, public adapters for major canonical stablecoins, reference destination-action packages, mainnet evidence, threat models, integration documentation, and an independent review report. The core will remain free of runtime dependencies and the provider packages will remain separable, so developers install only the trust boundaries they choose.

USDC over CCTP is the first proven route, not the scope of the public good. The architecture is stablecoin- and provider-neutral. USDT over USDT0/LayerZero, USDG over LayerZero OFT, and a disclosed Binance-Peg USDC adapter already implement the same contract, although the non-USDC routes still require credentials or mainnet validation. The grant converts this honest alpha into a reviewed beta with multiple stablecoin families and documented adoption.

### Specific benefits to Solana developers

**One integration contract.** A wallet, payments, lending, trading, vault, subscription, or commerce application can support multiple funding providers without binding its application code to each provider's quote, signing, status, and refund format.

**Solana-specific settlement evidence.** The verifier checks an exact destination transaction, the configured program, token-program ownership, mint identity, recipient ownership, and measured credit. Grant work extends the matrix across SPL Token and Token-2022 and exposes the result as a typed public API.

**Stablecoin identity rather than ticker matching.** Quotes name chain, token program or contract, mint, issuer boundary, and any transformation. Hidden stablecoin swaps are rejected by default. Adapter routes must disclose that the source and destination assets cross an issuer boundary.

**Non-custodial wallet integration.** Plugins return ordered, unsigned wallet requests. The SDK never receives wallet objects or private keys and never provides a sign-and-send shortcut.

**Credentials stay server-side.** A framework-neutral remote transport preserves the plugin contract and error codes while keeping provider API keys, target allowlists, rate limits, and host policy outside browser bundles.

**Crash-safe resumability.** Applications persist a versioned flow record. Restored flows retain settled-funding evidence but discard stale unsigned transactions and fail closed on unknown versions or corrupt state.

**Application-aware routing.** The rail ranks the guaranteed final Solana outcome, then optionally refreshes a Jupiter, lending, or deposit action from the amount actually received. Funding-only integrations remain supported.

**Executable compatibility.** Provider and action authors run the same public conformance suite used by first-party packages. This turns behavioral expectations into tests instead of prose alone.

## 3. Product Design

### Architecture & how it works

The design separates capital movement from the Solana application action.

1. A host creates a `FundingIntent` containing the source account and asset, destination Solana account and settlement asset, amount, slippage policy, and an optional destination action.
2. Registered `FundingProviderPlugin` instances discover routes and return quotes containing exact asset identities, minimum output, fees, expiry, risk disclosures, and opaque provider data.
3. The zero-runtime-dependency core validates quote shape, asset policy, execution mode, expiration, provider pins, and minimum-output guarantees before ranking routes.
4. The selected provider prepares ordered `WalletStep` values for the user's source wallet. The host renders and submits them; the SDK never signs.
5. The host immediately persists the submitted transaction reference. `RailFlow` polls the provider and handles retryable status or RPC failures without incorrectly terminalizing funds already in flight.
6. Completion requires Solana evidence. For current CCTP V2 responses, the provider follows Circle's `forwardTxHash`, reads that exact Solana transaction, requires an allowed CCTP program, and measures the matching owner-and-mint credit. Provider-reported amounts below the quote minimum fail closed.
7. For funding-only intents, the verified settlement completes the flow. For an application action, the core refreshes the destination quote using the confirmed received amount, returns an unsigned Solana request, and verifies the final application outcome.

The packages form five trust boundaries:

**Core.** Package: `@hedgents/stablecoin-rail`. Domain types, quote validation and ranking, plugin contracts, flow state machine, serialization and hydration, remote transport, settlement-verifier interface, and conformance suites. It has zero runtime dependencies.

**Solana verifier.** Package: `@hedgents/stablecoin-rail-solana`. Address and associated-token-account derivation, Base58 handling, SPL token ownership checks, exact transaction attribution, measured credit, and RPC error classification. Grant work hardens this around `@solana/kit` and Token-2022.

**Funding providers.** Separate CCTP, LayerZero, Mayan, and Allbridge assessment packages translate provider APIs into the public contract. Credentials can remain behind the remote transport.

**Destination actions.** Grant-funded Jupiter and lending/deposit packages consume only verified settlement amounts, simulate or validate Solana requests, and verify final outcomes. They remain separate from bridge providers.

**Host bindings and reference application.** React bindings expose the state machine without owning wallets. The reference application demonstrates funding-only flows, provider ranking, server-side credentials, persistence, recovery, and destination actions.

The grant scope is deliberately not “build another cross-chain wrapper.” The general plugin core already exists. Funding is directed to Solana-specific infrastructure: Token and Token-2022 verification, exact transaction attribution, unsigned Solana wallet requests, application-action safety, Solana protocol integrations, and adoption by Solana applications.

### Key features

**Provider-neutral route contract:** common quote, preparation, status, refund, and conformance APIs.

**Exact asset policy:** chain namespace, contract or mint, token program, issuer relationship, and transformation disclosure.

**Guaranteed-output routing:** compare minimum settlement or final application output, not marketing estimates.

**Exact Solana verification:** attribute delivery to a destination transaction and measure the matching credit.

**Fail-closed request validation:** reject unexpected signers, chains, contracts, programs, assets, expiries, and ambiguous output.

**Two-phase application safety:** fund first, verify the amount received, then re-quote and prepare the destination action.

**Crash recovery:** serialize and hydrate flows without replaying stale unsigned transactions or losing settled-funding evidence.

**Remote provider transport:** keep secrets and commercial credentials on the host's server without changing the plugin API.

**Public conformance suite:** reusable behavioral tests for third-party provider and action plugins.

**Reproducible evidence:** deterministic fixtures for CI plus separate read-only live-proof commands and documented mainnet transfers.

### Integration into existing developer workflows

Developers install the core, Solana package, and only the provider or action packages they use. A funding-only application can construct a `RailClient`, register remote or direct provider plugins, request quotes, present unsigned steps through its existing wallet adapter, persist the serialized flow, and render status. No Hedgents account or hosted endpoint is required.

Teams with provider credentials expose the framework-neutral rail handler through an existing Next.js route, Express server, Worker, or equivalent backend. Browser code registers a remote plugin with the same manifest and contract. Authorization, jurisdiction policy, rate limits, and transaction caps remain explicit host responsibilities rather than implied SDK protections.

CI usage follows ordinary TypeScript workflows: run strict builds and the public conformance suite against each configured plugin. First-party packages use recorded upstream fixtures for deterministic tests. Clean-room package checks install public npm artifacts outside the workspace, catching export-map or omitted-file failures that workspace linking can hide. Live commands are separate because provider APIs and public RPCs are not deterministic test dependencies.

The reference application and documentation will include copyable funding-only, remote-provider, persistence, Jupiter-action, and lending/deposit examples. Migration notes and versioned schemas will accompany breaking changes.

### Technology stack

**Language and packaging:** TypeScript 5.9, ECMAScript modules, Node.js 20 or later, npm workspaces, package export maps, and npm provenance attestations.

**Solana:** Solana JSON-RPC, `@solana/kit` in the grant-funded verifier, SPL Token and Token-2022 account and instruction semantics, unsigned transaction or instruction requests, and public mainnet/devnet fixtures.

**Provider integrations:** Circle CCTP V2 APIs and Forwarding Service, LayerZero Value Transfer API and OFT routes, Mayan quote/forwarding APIs, and optional pool-liquidity assessment.

**Application bindings:** framework-neutral core APIs, Fetch-compatible remote transport, optional React 18+ bindings, and a Vite reference application.

**Testing and delivery:** Node.js built-in test runner, strict TypeScript compilation, recorded fixtures, shared conformance suites, GitHub Actions, package dry-runs, clean-room npm verification, and read-only live-proof scripts.

**Security posture:** no signing dependency in the core or verifier, no custody, no project token, no deployed Solana program, provider credentials server-side, explicit allowlists and asset pins, and Apache-2.0 licensing.

### Proof-of-Concept

Public repository: [GitHub monorepo](https://github.com/Hedgents/stablecoin-rail)

Reference integration: [bridge demo source](https://github.com/Hedgents/stablecoin-rail/tree/main/examples/bridge-demo)

Current status and limitations: [status and evidence document](https://github.com/Hedgents/stablecoin-rail/blob/main/docs/STATUS.md)

Ethereum source burn: [Etherscan transaction](https://etherscan.io/tx/0x509ce416c0fd1908053e39221e1c1e157a4e52324514882296fbf194df5152f1)

Circle message and forwarding evidence: [Circle CCTP V2 message](https://iris-api.circle.com/v2/messages/0?transactionHash=0x509ce416c0fd1908053e39221e1c1e157a4e52324514882296fbf194df5152f1)

Exact Solana delivery: [Solscan transaction](https://solscan.io/tx/KwTk3nn76FWS1CtmtEHbVJsURJNLvBAdJ7jhGqqj2Mr8qHCHasVYrdeC3e4gnx1QELX1pJkUxUxK8s8JDpX3rqw)

Reproduction command: `npm run verify:cctp-proof` builds the Solana and CCTP packages, replays the public Circle response, reads the exact forwarded Solana transaction, and verifies the 4.875317 USDC credit.

Current evidence is intentionally bounded: Ethereum USDC to Solana USDC is the only mainnet-proven route, the remaining providers are fixture-tested, and no independent security review has occurred yet.

## 4. Budget Breakdown (Milestones)

The total request is $40,000. Component betas total $30,000, six months of maintenance total $6,000, and measurable adoption totals $4,000. Component work is planned for twelve weeks. Maintenance and adoption begin after the production beta release.

### 4a. Completed First Version (Beta) — per component

#### Component 1 — Stablecoin route standard and conformance suite v1 — $5,000 — weeks 1–2

**Beta scope:** Publish versioned funding-provider and destination-action specifications covering exact asset identity, canonical versus adapter routes, minimum output, expiry, wallet-request pins, settlement evidence, refunds, recovery, error semantics, and version compatibility. Extend the executable conformance suite so every first-party plugin is judged against the same public contract.

**Testing plan:** Schema tests for valid and adversarial inputs; conformance cases for quote, preparation, status, refund, transient failures, malformed provider responses, minimum-delivery failures, serialization, and unknown versions; CI matrix across every first-party plugin and remote-transport mode.

**Success criteria:** Versioned specification and threat model published; public testing package documented; CCTP, LayerZero, and Mayan plugins pass the same suite directly and through remote transport; all confirmed failures have stable public error codes.

#### Component 2 — Solana settlement verifier beta — $7,000 — weeks 2–5

**Beta scope:** Deliver a typed verifier based on `@solana/kit` for SPL Token and Token-2022. Verify exact transaction identity, transaction success, allowed program participation, destination account ownership, mint, token program, owner, and measured credit. Make indexing lag and transient RPC failures retryable while deterministic mismatches fail closed.

**Testing plan:** Unit matrices for Token and Token-2022 accounts and instructions; adversarial tests for unrelated deposits, concurrent same-size credits, post-quote spends, wrong mint/owner/program, failed transactions, malformed signatures, RPC errors, and below-minimum delivery; recorded mainnet fixtures; read-only live replay of the published CCTP proof.

**Success criteria:** Public typed API with no wallet or signing dependency; exact-credit verification for both token programs; deterministic fixture suite; live proof command returns the documented destination transaction and amount; integration guide published.

#### Component 3 — Major stablecoin provider betas — $7,000 — weeks 4–8

**Beta scope:** Productionize USDC over CCTP plus one canonical USDT route and one canonical USDG route. Pin contract and mint identities, provider programs, credential requirements, issuer relationships, transformations, minimums, and refund behavior. Keep routes disabled when required keys or allowlists are absent.

**Testing plan:** Recorded upstream fixtures, shared conformance suite, clean-room npm installation, one small-value mainnet proof for each enabled stablecoin family, and documented tests of failure, timeout, short-delivery, and refund states where provider support permits.

**Success criteria:** Three stablecoin families represented by public provider packages; one reproducible proof per production-enabled family; route matrix publishes fees, latency, evidence, and limitations; no provider credential appears in the reference browser bundle. If LayerZero credentials remain unavailable, the USDG/USDT packages remain safely gated and the milestone substitutes a permissionless canonical route rather than weakening validation.

#### Component 4 — Solana destination actions and reference application — $5,000 — weeks 7–10

**Beta scope:** Ship reference Jupiter and lending/deposit action packages. Each action consumes only the amount verified after settlement, refreshes stale quotes, returns unsigned Solana requests, validates account ownership and allowed programs, and verifies the final application outcome. Extend the reference application with funding-only and funding-plus-action flows, server-side credentials, resume, and failure recovery.

**Testing plan:** Recorded quote fixtures, simulations where available, allowed-program and account-owner checks, expired-quote and changed-account tests, below-minimum action output, action-unavailable-after-funding recovery, strict typecheck, production build, and end-to-end flows on devnet or small-value mainnet environments as supported.

**Success criteria:** Two public action packages; funding-plus-action example; action quote always derives from measured settlement; stale or unexpected requests fail closed; reference application builds independently against published npm artifacts.

#### Component 5 — Independent review and production release — $6,000 — weeks 9–12

**Beta scope:** Commission a focused independent review of the core contracts, Solana verifier, and first-party provider/action boundaries. Remediate confirmed findings, publish the report and remediation status, finalize versioning and maintenance policy, and publish a production beta with provenance.

**Testing plan:** Independent threat-model review and code review; regression test for each confirmed issue; full deterministic suite, typecheck, package dry-runs, clean-room installation, reference application build, and live proof replay before release.

**Success criteria:** Public review report and remediation log; zero unresolved critical findings at release; all packages published with provenance under documented versions; installation, migration, security, and maintenance documentation complete.

### 4b. Maintenance — minimum 6 months

**Total maintenance budget:** $6,000, paid as six monthly milestones of $1,000 after the production beta release.

Active maintenance includes public issue triage; bug and security fixes; compatibility checks against supported Node, Solana RPC, token-program, and provider API versions; fixture refreshes when upstream schemas change; documentation and migration corrections; release notes; and a monthly maintenance report. Critical security reports will be acknowledged within two business days, with a mitigation, route disablement, or remediation plan published as appropriate. High-severity correctness bugs will be acknowledged within five business days.

Each month is accepted when the public maintenance report is posted, CI is green for supported configurations, upstream compatibility has been checked, and critical or high issues opened during the month are resolved or have a documented mitigation and delivery date.

### 4c. User Adoption

**Total adoption budget:** $4,000, measured during the six months following the production beta release.

#### Adoption milestone 1 — First external Solana application integration — $1,000

**Target:** One Solana application outside this repository integrates a production-beta package and completes a documented funding flow.

**Evidence:** Public dependency or integration code, a production or public-test release, maintainer confirmation, and at least one redacted or public transaction reference demonstrating the integrated path.

#### Adoption milestone 2 — Second external Solana application integration — $1,000

**Target and evidence:** The same criteria as milestone 1, for a second unaffiliated application.

#### Adoption milestone 3 — 50 verified funding flows through external integrations — $2,000

**Target:** Fifty completed funding flows across the external integrations, excluding Hedgents development and automated test traffic.

**Tracking:** Integration partners provide privacy-preserving aggregate completion counts and sampled public transaction references. The rail will define a small optional completion-event interface that records provider, route, settlement family, completion time, and destination reference without wallet identity or personal data. No telemetry is enabled by the SDK itself.

**Proportional payment:** $500 at 13 cumulative flows, $500 at 25, $500 at 38, and $500 at 50.

### Milestone Summary Table

| # | Milestone / Deliverable | Success Criteria | Amount (USD) |
|---:|---|---|---:|
| 1 | Route standard and conformance suite v1 | Public spec, threat model, and direct/remote conformance across first-party plugins | $5,000 |
| 2 | Solana settlement verifier beta | SPL Token and Token-2022 exact-credit API, adversarial matrix, live proof replay | $7,000 |
| 3 | Major stablecoin provider betas | Three stablecoin families represented; reproducible proof for each production-enabled family | $7,000 |
| 4 | Destination actions and reference app | Jupiter and lending/deposit packages; independently built funding-plus-action example | $5,000 |
| 5 | Independent review and production release | Public report, remediation log, zero unresolved critical findings, provenance release | $6,000 |
| 6 | Maintenance month 1 | Monthly report, compatibility check, green CI, severe-issue disposition | $1,000 |
| 7 | Maintenance month 2 | Monthly report, compatibility check, green CI, severe-issue disposition | $1,000 |
| 8 | Maintenance month 3 | Monthly report, compatibility check, green CI, severe-issue disposition | $1,000 |
| 9 | Maintenance month 4 | Monthly report, compatibility check, green CI, severe-issue disposition | $1,000 |
| 10 | Maintenance month 5 | Monthly report, compatibility check, green CI, severe-issue disposition | $1,000 |
| 11 | Maintenance month 6 | Monthly report, compatibility check, green CI, severe-issue disposition | $1,000 |
| 12 | First external integration | One unaffiliated application meets published integration evidence criteria | $1,000 |
| 13 | Second external integration | A second unaffiliated application meets the same criteria | $1,000 |
| 14 | 50 verified external funding flows | Four proportional checkpoints: 13, 25, 38, and 50 flows | $2,000 |
|  | **Total** |  | **$40,000** |

## 5. Acknowledgements

**Yes.** The project will release a published production version by the end of the grant agreement.

**Yes.** The project will be completely public and open-source.

**Yes.** The team agrees to at least six months of active maintenance under the monthly milestones above.

**Yes.** The team agrees to meet and report the quantifiable user-adoption metrics above.
