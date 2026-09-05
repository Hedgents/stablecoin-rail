# @hedgents/stablecoin-rail-solana

Solana address helpers and settlement verification for the [Hedgents Stablecoin Rail](https://github.com/Hedgents/stablecoin-rail).

This package exists so that every Solana-settling funding provider can answer one question the same way: **how much actually arrived?**

## Install

```bash
npm install @hedgents/stablecoin-rail-solana@alpha
```

## Settlement verification

A funding provider's status API usually proves that delivery happened, not how much was delivered. Without independent verification the rail sizes the destination action from the *quoted minimum*, and a short delivery goes unnoticed.

```ts
import { RailClient } from "@hedgents/stablecoin-rail";
import { createSolanaSettlementVerifier } from "@hedgents/stablecoin-rail-solana";

const rail = new RailClient({
  fundingProviders: [/* ... */],
  settlementVerifier: createSolanaSettlementVerifier({
    rpcUrl: process.env.SOLANA_RPC_URL,
  }),
});
```

The verifier reads the delivery transaction and returns the destination token account's balance delta. The core then compares it against the funding quote's guaranteed minimum and **throws `SETTLEMENT_BELOW_MINIMUM` on a short delivery** rather than continuing into the destination action.

### It returns null, it does not throw

Every unverifiable condition returns `null`: the transaction is not indexed yet, the RPC call failed, the transaction failed, no balance entry matches the owner and mint, the balance did not increase, or the mint is served by an unexpected token program.

That is deliberate. By the time verification runs the user's funds have already moved, so an RPC hiccup must degrade to the rail's quoted-minimum fallback rather than break the flow. Rejecting a short delivery is the core's decision, not the verifier's.

### Token-2022

Pass the expected program when settling a Token-2022 asset:

```ts
import { createSolanaSettlementVerifier, TOKEN_2022_PROGRAM_ID } from "@hedgents/stablecoin-rail-solana";

createSolanaSettlementVerifier({ rpcUrl, tokenProgram: TOKEN_2022_PROGRAM_ID });
```

A delivery served by a different token program than the one configured is not the asset that was quoted, so it verifies as `null`.

## Address helpers

```ts
import {
  deriveAssociatedTokenAddress,
  decodeBase58,
  encodeBase58,
  toBytes32,
} from "@hedgents/stablecoin-rail-solana";

deriveAssociatedTokenAddress(ownerWallet, usdcMint);
toBytes32(tokenAccount); // 32-byte hex, for EVM bridge calls such as CCTP mintRecipient
```

`deriveAssociatedTokenAddress` performs the on-curve rejection that program-derived address generation requires: it walks bump seeds downward and skips any candidate that is a valid ed25519 point. Skipping that check returns a wrong address whenever the first candidate lands on the curve, roughly one owner and mint pair in 256, and fails silently. This is why the package depends on `@noble/curves` as well as `@noble/hashes`.

Golden vectors in the test suite were produced by an independent implementation and matched byte for byte, including a case whose correct bump is 254.

## Status

Alpha. See the repository's security policy before enabling any route in production.

## Licence

Apache-2.0
