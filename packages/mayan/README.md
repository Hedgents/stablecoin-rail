# @hedgents/stablecoin-rail-mayan

Mayan **adapter route** for Binance-Peg USDC on BNB Chain into native Solana USDC, for the [Hedgents Stablecoin Rail](https://github.com/Hedgents/stablecoin-rail).

## Read this before using it

**This is not Circle CCTP, and it is not a like-for-like USDC transfer.**

The USDC commonly held on BNB Chain is *Binance-Peg USDC*, issued by Binance, not a native Circle deployment. There is no CCTP path for it. Mayan swaps it for native Solana USDC, so the route crosses an issuer boundary and carries swap and solver risk that a native CCTP route does not.

The rail's default principle is that a stablecoin family does not silently change underneath the user. This route is the deliberate, disclosed exception. Accordingly:

- The plugin is named **"Mayan adapter (Binance-Peg USDC)"**, so no interface can render it as native CCTP.
- Every quote carries a `disclosure` string in `opaqueData` naming the issuer difference and the swap. Surface it.
- The provider declines native USDC on Ethereum or Base; those belong to `@hedgents/stablecoin-rail-cctp`.

## Use

Mayan's SDK is **injected rather than depended upon**, so this package pulls in no vendor code, stays testable without network access, and leaves the SDK version under your control.

```ts
import { fetchQuote, getSwapFromEvmTxPayload } from "@mayanfinance/swap-sdk";
import { createMayanBnbToSolana } from "@hedgents/stablecoin-rail-mayan";

const mayan = createMayanBnbToSolana({
  sdk: { fetchQuote, getSwapFromEvmTxPayload },
  rpcUrl: process.env.SOLANA_RPC_URL,
  apiKey: process.env.MAYAN_API_KEY,
});
```

## What the user signs

Two BNB Chain steps, both with zero native value:

1. **An exact-amount approval** to Mayan's Forwarder. Never unlimited.
2. **The Forwarder call** built by Mayan's SDK.

Before either is returned, the adapter checks the SDK's output: the target must be Mayan's published Forwarder (`0x337685fdaB40D39bd02028545a4FfA7D287cC3E2`), the calldata must be well formed, and the native value must be zero. A quote-driven SDK must never be able to send a user somewhere else.

## Amounts

Mayan reports output amounts as human-readable JavaScript numbers. They are converted to base units by **flooring**, because the figure becomes a guaranteed minimum and claiming more than the protocol guarantees is the unsafe direction.

Truncating the raw double would be wrong: `99.1` is not exactly representable and prints as `99.09999999999999`, so a naive floor loses a base unit on an ordinary quote. Binary noise is absorbed by rounding two places beyond what is kept, then truncating. Amounts far above ~1e9 units cannot be converted exactly, which is a limitation of an API that sends money as a JS number.

Routes whose destination token is not the configured settlement mint, or whose input amount differs from the intent, are discarded rather than quoted.

## How completion is decided

Mayan does not publish an exhaustive status enumeration, and its explorer exposes no destination-chain transaction hash. Only the refund and failure status families are matched by name.

Completion is therefore proven on-chain rather than inferred from a string: the adapter records the destination token account balance at quote time and reports `completed` only once that balance has risen by at least the guaranteed minimum. `received` is left `null`, so the rail keeps its conservative quoted-minimum fallback rather than claiming a figure it cannot substantiate.

## Status

Alpha. **No mainnet transfer has been completed on this route.** Do not enable in production before a small-value proof and an independent security review.

## Licence

Apache-2.0
