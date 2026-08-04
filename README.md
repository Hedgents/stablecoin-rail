# Hedgents Stablecoin Rail

A headless, plugin-based SDK for bringing stablecoin capital from another chain into a Solana application and completing an application-specific destination action.

This is not a bridge and does not operate a solver network. It orchestrates existing funding providers such as CCTP or intent networks behind one consistent user experience.

```text
source stablecoin → funding-provider plugin → Solana settlement asset → destination-action plugin
```

Hedgents' metal terminal is the first reference application: a user can fund with a supported stablecoin on another chain, receive the same canonical stablecoin on Solana, then sign a separate Jupiter metal purchase. No stablecoin-to-stablecoin swap is implied.

## Packages

- `@hedgents/stablecoin-rail` — framework-neutral router, plugin contracts, quote ranking, and explicit flow state machine.
- `@hedgents/stablecoin-rail-solana` — Solana address helpers and a settlement verifier that confirms the exact amount delivered.
- `@hedgents/stablecoin-rail-cctp` — Circle CCTP V2 provider moving native USDC from Ethereum, Base, or Arbitrum into a Solana wallet.
- `@hedgents/stablecoin-rail-mayan` — disclosed adapter route for Binance-Peg USDC on BNB Chain into native Solana USDC. Not CCTP.
- `@hedgents/stablecoin-rail-layerzero` — server-side USDT0/LayerZero adapter for canonical TRON USDT → canonical Solana USDT.
- `@hedgents/stablecoin-rail-react` — a small `useRailFlow` hook over the core state machine.

## First dedicated provider adapter

```text
TRON USDT (TR7N…Lj6t)
  → USDT0 Legacy Mesh / LayerZero Value Transfer API
  → Solana USDT (Es9v…wNYB)
  → destination action
```

The LayerZero adapter pins both token contracts and both chains, ranks the provider's executable quotes by minimum output, requests fresh unsigned TRON transactions, verifies the expected signer, and tracks delivery or refunds. It requires a server-side LayerZero API key and has not yet passed a small-value mainnet transfer; keep it disabled in production until that test is complete.

This is one adapter, not the scope of the rail. The product is designed to fund Solana actions with USDC, USDT, USDG, and future verified stablecoins from any supported source chain.

## Install

```bash
npm i @hedgents/stablecoin-rail@alpha @hedgents/stablecoin-rail-cctp@alpha
```

Alpha, and deliberately so: no route has completed a mainnet transfer and there
has been no independent security review. See [docs/STATUS.md](docs/STATUS.md).

## Try it

`examples/bridge-demo` is a small website that moves a stablecoin from another chain into a Solana wallet. It is the shortest complete integration reference: funding-only intents, ranking across three providers, resume, and provider credentials kept server-side.

```bash
npm install && npm run dev -w @hedgents/rail-example-bridge-demo
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
npm install @hedgents/stablecoin-rail
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
          {route.funding.providerName}: at least {route.action.minimumOutput.amountBaseUnits}
        </button>
      ))}
    </section>
  );
}
```

## Repository status

This is an alpha SDK. The public interfaces are usable and tested, but production provider adapters should not be enabled before targeted mainnet tests and an independent security review.

See [the product vision and MVP](docs/PRODUCT_VISION_AND_MVP.md), [architecture](docs/ARCHITECTURE.md), [UX contract](docs/UX.md), [plugin authoring guide](docs/PLUGINS.md), and [publishing checklist](docs/PUBLISHING.md).
