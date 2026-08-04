# @hedgents/stablecoin-rail-allbridge

Pool-liquidity assessment for Allbridge Core routes, for the [Hedgents Stablecoin Rail](https://github.com/Hedgents/stablecoin-rail).

## Why this exists

Allbridge Core is **pool-based**, not canonical. Your token enters a pool on the source chain and a *different* token leaves a pool on the destination. A transfer therefore **withdraws from the destination pool**, which makes that side the binding constraint even when the source looks deep.

At the time of writing the TRON USDT pool held ~$384k while the Solana side held ~$127k. A $10,000 transfer is 2.6% of the source and **7.9% of the pool that actually has to pay it out**. Reading the wrong side understates the risk threefold.

The rail already protects a user numerically through the guaranteed minimum. This module explains *why* that number moves, before they commit.

## Use

```ts
import { createAllbridgePoolReader } from "@hedgents/stablecoin-rail-allbridge";

const reader = createAllbridgePoolReader();
const assessment = await reader.assess({
  sourceChainKey: "TRX",
  destinationChainKey: "SOL",
  symbol: "USDT",
  amountBaseUnits: 10_000_000_000n,
});

assessment.band;   // "low" | "moderate" | "high" | "severe"
assessment.reason; // plain language, safe to show a non-technical user
```

No API key. Allbridge's token registry is public, and it publishes the bridge contract addresses in the same response, which is why this route needs no privately negotiated allowlist.

## Bands

Thresholds live here rather than in a UI, so a caller cannot quietly redefine what "high" means.

| Band | Transfer as share of destination depth |
|---|---|
| low | under 1% |
| moderate | 1 to 5% |
| high | 5 to 15% |
| severe | over 15% |

A destination pool under 25% token share is **severe at any size**, because a depleted pool is expensive regardless of how little you send.

## One trap worth knowing

Allbridge reports pool figures at a fixed **3-decimal system precision**, not the token's own decimals. Reading them naively displays $127 where the pool holds $127,192, a 1000x understatement that makes every route look catastrophic. The arithmetic confirms the precision (`tokenBalance + vUsdBalance` reconciles to `dValue`), and a test pins it.

## Scope

Liquidity assessment only. This package does not execute transfers: Allbridge has no public quote endpoint, so a transfer adapter would need `@allbridge/bridge-core-sdk` injected by the host.

## Licence

Apache-2.0
