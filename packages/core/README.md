# @hedgents/stablecoin-rail

Framework-neutral plugin contracts, quote routing, and an explicit state machine for funding Solana application actions from stablecoins on other chains.

```bash
npm install @hedgents/stablecoin-rail
```

```ts
import {
  RailClient,
  defineDestinationAction,
  defineFundingProvider,
} from "@hedgents/stablecoin-rail";
```

Funding-provider plugins quote and track stablecoin settlement. Destination-action plugins quote and prepare the Solana action. The SDK ranks the guaranteed final output, returns unsigned wallet steps, and refreshes the destination quote after settlement.

This is an alpha API. Production plugins must pin allowed chains, assets, contracts, programs, and spenders and verify settlement from provider or chain state.
