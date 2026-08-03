# @hedgents/stablecoin-rail-cctp

Circle CCTP V2 funding provider for the [Hedgents Stablecoin Rail](https://github.com/Hedgents/stablecoin-rail). Moves **native** USDC from an EVM chain into a user's Solana wallet through Circle's Forwarding Service.

## Install

```bash
npm install @hedgents/stablecoin-rail-cctp
```

## Use

Source chains are configuration, not code. Adding a CCTP domain is a new entry, not a new package.

```ts
import { RailClient } from "@hedgents/stablecoin-rail";
import {
  createCctpToSolana,
  ETHEREUM_MAINNET,
  BASE_MAINNET,
  SOLANA_MAINNET,
} from "@hedgents/stablecoin-rail-cctp";

const rail = new RailClient({
  fundingProviders: [
    createCctpToSolana({
      sources: [ETHEREUM_MAINNET, BASE_MAINNET],
      solana: SOLANA_MAINNET,
      rpcUrl: process.env.SOLANA_RPC_URL,
    }),
  ],
});
```

`ARBITRUM_MAINNET` is also exported. Every configured address is validated against EIP-55 at construction, because a mis-typed address is unrecoverable and the checksum catches almost every single-character slip.

## What the user signs

Two EVM steps, both with zero native value:

1. **An exact-amount approval** to Circle's TokenMessenger. Never unlimited, so no allowance survives the transfer.
2. **`depositForBurnWithHook`**, carrying a Forwarding Service hook that names the recipient.

The hook's trailing thirty-two bytes are the user's **wallet**, not their token account. Circle derives the account itself, and the create-ATA flag is set only when the account does not already exist, so the quoted fee covers rent exactly when it needs to.

## Fees and minimum output

Quoting reads Circle's live fee schedule and sets `minimumOutput = amount - (forwardFee + protocolFee)`. The protocol fee is rounded **up**: a `maxFee` a single base unit below what Circle charges makes the burn unusable, while erring high costs at most one base unit. An amount that does not clear fees plus a buffer is refused rather than quoted.

## How completion is decided

This is the part worth reading before you trust it.

Circle's message API tells you the burn has been **attested**. Attestation means the message is signed, **not** that USDC reached the user, and Circle exposes no destination-chain transaction identifier for a forwarded transfer. Reporting `completed` on attestation alone would tell the rail that funding had settled when it may not have.

So this provider proves delivery the only way that is actually provable: it records the destination token account's balance at quote time and reports `completed` only once that balance has risen by at least the guaranteed minimum. Until then it stays `pending` with a detail explaining which stage it is in.

Consequently `destinationReference` is `null` and `received` is left `null`, because there is no delivery transaction to point at and no honest exact figure to claim. The rail falls back to the quoted minimum, which is conservative by design. Exact-amount verification for this route awaits a delivery-transaction identifier from Circle.

## Not supported

**BNB Chain.** Its commonly held USDC is Binance-Peg, not a native Circle CCTP source asset. Routing it here would misrepresent the trust boundary, so the provider declines it; a conformance case asserts that. Use a separately disclosed adapter for that path.

## Status

Alpha. **No CCTP route has completed a mainnet transfer.** Do not enable in production before a small-value proof and an independent security review.

## Licence

Apache-2.0
