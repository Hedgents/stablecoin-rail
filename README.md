# Open stablecoin ingress for Solana applications

A headless, plugin-based SDK that lets Solana applications accept major stablecoins from other chains, verify what arrived, and optionally continue into an application-specific destination action.

This is not a bridge and does not operate a solver network. It turns CCTP, OFT networks, and intent providers into interchangeable funding plugins behind one fail-closed contract.

```text
source stablecoin → funding-provider plugin → Solana settlement asset → destination-action plugin
```

USDC over CCTP is the first proven route, not the scope of the product. The same core already models canonical USDT over USDT0/LayerZero, USDG over LayerZero OFT, and explicitly disclosed adapter routes where the source asset crosses an issuer boundary.

## Packages

- `@hedgents/stablecoin-rail` — framework-neutral router, plugin contracts, quote ranking, and explicit flow state machine.
- `@hedgents/stablecoin-rail-solana` — Solana address helpers and a settlement verifier that confirms the exact amount delivered.
- `@hedgents/stablecoin-rail-cctp` — Circle CCTP V2 provider moving native USDC from Ethereum, Base, Arbitrum, or Monad into a Solana wallet.
- `@hedgents/stablecoin-rail-mayan` — disclosed adapter route for Binance-Peg USDC on BNB Chain into native Solana USDC. Not CCTP.
- `@hedgents/stablecoin-rail-layerzero` — server-side adapters for canonical TRON USDT and Robinhood Chain USDG into their canonical Solana assets.
- `@hedgents/stablecoin-rail-allbridge` — pool-depth and liquidity-risk assessment for pool-based routes.
- `@hedgents/stablecoin-rail-react` — a small `useRailFlow` hook over the core state machine.

## Multi-stablecoin by design

```text
source stablecoin
  → exact asset identity and provider policy
  → verified Solana settlement asset
  → optional destination action
```

Every adapter must pin chains and asset identities, quote a guaranteed minimum, return unsigned wallet requests, and prove settlement or refunds. Canonical like-for-like routes stay distinct from swap or issuer-boundary routes; the SDK never treats a shared ticker as proof that two tokens are the same asset.

The current LayerZero routes require a server-side API key and have not yet passed small-value mainnet transfers. They remain disabled in production until that validation is complete.

## Install

```bash
npm i @hedgents/stablecoin-rail@alpha @hedgents/stablecoin-rail-cctp@alpha
```

Alpha. One route (Ethereum USDC to Solana) has completed a real mainnet
transfer; every other route is unproven, and there has been no independent
security review. See [docs/STATUS.md](docs/STATUS.md).

## Try it

`examples/bridge-demo` is a small website that moves a stablecoin from another chain into a Solana wallet. It is the shortest complete integration reference: funding-only intents, ranking across three providers, resume, and provider credentials kept server-side.

```bash
cd examples/bridge-demo
npm install
npm run dev
```

## Design principles

- **Provider-neutral:** CCTP, Mayan, Across, or a future rail can implement the same contract.
- **Action-neutral:** Jupiter is one destination action; lending, staking, checkout, or minting are plugins too.
- **Non-custodial:** plugins prepare wallet requests but never sign them.
- **Honest atomicity:** multi-chain funding and the Solana action are separate phases unless a provider explicitly guarantees composition.
- **Fail closed:** quotes expire, minimum output is mandatory, and every plugin is responsible for pinning its allowed targets.
- **Observable UX:** source submission, settlement, destination execution, refunds, and failures are explicit states.
- **Fresh execution:** the destination action is quoted again after settlement from the confirmed received amount.

## Quick start

```bash
npm install @hedgents/stablecoin-rail@alpha
```

```ts
import {
  RailClient,
  defineDestinationAction,
  defineFundingProvider,
} from "@hedgents/stablecoin-rail";

const ethereumCctp = defineFundingProvider({
  manifest: {
    id: "circle-cctp",
    name: "Circle CCTP",
    version: "1.0.0",
    apiVersion: 1,
    kind: "funding-provider",
  },
  supports: (intent) =>
    intent.source.account.chainId === "eip155:1" &&
    intent.destination.account.chainId.startsWith("solana:"),
  quote: async (intent) => quoteCctpOnYourServer(intent),
  prepare: async ({ intent, quote }) => prepareCctpOnYourServer(intent, quote),
  getStatus: async ({ reference }) => readCctpStatus(reference),
});

const jupiterSwap = defineDestinationAction({
  manifest: {
    id: "jupiter-swap",
    name: "Jupiter swap",
    version: "1.0.0",
    apiVersion: 1,
    kind: "destination-action",
  },
  supports: ({ intent }) => intent.destination.account.chainId.startsWith("solana:"),
  quote: async (request) => quoteJupiterOnYourServer(request),
  prepare: async ({ intent, fundingQuote, actionQuote }) =>
    buildJupiterTransaction(intent, fundingQuote, actionQuote),
  getStatus: async ({ reference }) => verifySolanaSignature(reference),
});

const rail = new RailClient({
  fundingProviders: [ethereumCctp],
  destinationActions: [jupiterSwap],
});

const batch = await rail.quote(intent);
const best = batch.quotes[0];
```

The SDK deliberately does not provide `signAndSend`. The application shows each prepared wallet request and asks the connected wallet to approve it.

## React

```tsx
import { useRailFlow } from "@hedgents/stablecoin-rail-react";

function FundingCheckout({ client, intent }) {
  const { snapshot, quote, selectQuote } = useRailFlow(client);

  return (
    <section>
      <button onClick={() => quote(intent)}>Find routes</button>
      <p>{snapshot.phase}</p>
      {snapshot.batch?.quotes.map((route) => (
        <button key={route.id} onClick={() => selectQuote(route.id)}>
          {route.funding.providerName}: at least{" "}
          {route.action?.minimumOutput.amountBaseUnits ?? route.funding.minimumOutput.amountBaseUnits}
        </button>
      ))}
    </section>
  );
}
```

## Repository status

This is an alpha SDK. The public interfaces are usable and tested, but production provider adapters should not be enabled before targeted mainnet tests and an independent security review.

See [the Solana Foundation grant brief](docs/SOLANA_FOUNDATION_GRANT.md), [product vision and MVP](docs/PRODUCT_VISION_AND_MVP.md), [architecture](docs/ARCHITECTURE.md), [UX contract](docs/UX.md), [plugin authoring guide](docs/PLUGINS.md), and [publishing checklist](docs/PUBLISHING.md).
