# @hedgents/stablecoin-rail-cctp

Circle CCTP V2 funding provider for the [Hedgents Stablecoin Rail](https://github.com/Hedgents/stablecoin-rail). Moves **native** USDC from an EVM chain into a user's Solana wallet through Circle's Forwarding Service.

## Install

```bash
npm install @hedgents/stablecoin-rail-cctp@alpha
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

Circle's message API tells you when the burn has been **attested** and, for a forwarded CCTP V2 transfer, returns the destination `forwardTxHash`. Attestation alone is not delivery: the provider reads that exact Solana transaction, requires it to succeed and invoke a configured CCTP program, then measures the credit for the quoted owner and mint. Only that evidence produces `completed`.

Before following the hash, the provider checks that Circle's decoded message matches the quote's destination domain, amount, and mint recipient. An invalid signature, a different program, a failed transaction, or a credit below the guaranteed minimum fails closed. The verified signature is reported as `destinationReference` and its measured credit as `received`.

A raw balance-versus-baseline comparison was rejected deliberately: an unrelated deposit would satisfy it, and an unrelated spend would starve it forever. A bounded recipient-account scan remains only for older or recorded Iris responses that omit `forwardTxHash`. On that compatibility path, concurrent same-size transfers can be ambiguous and a delivery pushed beyond `deliveryScanLimit` stays `pending`; current responses use the exact hash and have neither limitation.

## Not supported

**BNB Chain.** Its commonly held USDC is Binance-Peg, not a native Circle CCTP source asset. Routing it here would misrepresent the trust boundary, so the provider declines it; a conformance case asserts that. Use a separately disclosed adapter for that path.

## Status

Alpha. **Ethereum USDC → Solana USDC has completed one small-value mainnet transfer, and the current exact-transaction verifier replays it successfully.** Other source chains remain unproven, and there has been no independent security review. Do not enable the package broadly in production before those gates are closed.

## Licence

Apache-2.0
