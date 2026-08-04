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

So this provider finds the delivery transaction itself. Once the burn is attested, it first checks that Circle's decoded message matches the quote's destination domain, amount, and mint recipient (a mismatch is affirmative disproof and fails the transfer). It then scans the recipient token account's recent transactions for one that succeeded, involves Circle's CCTP V2 programs, and credits the recipient wallet by at least the guaranteed minimum. Only that transaction completes the transfer, and it is reported as `destinationReference` with the measured credit as `received`.

A raw balance-versus-baseline comparison was rejected deliberately: an unrelated deposit would satisfy it, and an unrelated spend would starve it forever. Attribution closes both. Two residual limitations are stated rather than hidden. First, two concurrent transfers of the same size to the same wallet can match the same delivery transaction, because Circle exposes nothing that ties a specific delivery to a specific burn; serialize same-wallet transfers at the host if that matters to you. Second, the scan reads the most recent `deliveryScanLimit` transactions (default 20) on the recipient token account; a recipient busy enough to push the delivery out of that window before a poll sees it stays `pending`, never falsely `completed`. Raise the limit for high-traffic recipients.

## Not supported

**BNB Chain.** Its commonly held USDC is Binance-Peg, not a native Circle CCTP source asset. Routing it here would misrepresent the trust boundary, so the provider declines it; a conformance case asserts that. Use a separately disclosed adapter for that path.

## Status

Alpha. **No CCTP route has completed a mainnet transfer.** Do not enable in production before a small-value proof and an independent security review.

## Licence

Apache-2.0
