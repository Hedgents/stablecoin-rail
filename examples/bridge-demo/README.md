# Bridge demo

A small website that moves a stablecoin from another chain into a Solana wallet, built on [`@hedgents/stablecoin-rail`](../../README.md). It exists to show the SDK working, and to be short enough to read as an integration reference.

```bash
npm install
npm run dev          # server on :8787, UI on :5173
```

## What it demonstrates

**Funding-only intents.** The intent carries no `action`, so nothing is ever signed on Solana. The user supplies a destination address, the stablecoin lands there, and the flow terminates at `completed`. This is the whole SDK minus the destination-action half.

**Route ranking across providers.** Circle CCTP for native USDC on Ethereum, Base, and Arbitrum; Mayan for Binance-Peg USDC on BNB Chain; USDT0 for canonical USDT on TRON. Quotes are ranked by guaranteed settlement output rather than advertised bridge fee, and providers that decline a route appear under "declined" rather than vanishing.

**Credentials never reaching the browser.** `server.mjs` mounts `createRailHandler` with the real providers, holding the Solana RPC URL, the Mayan key, and the USDT0 allowlist. The browser builds `createRemoteFundingProvider` against `/api/rail` and holds nothing but a contract and an endpoint.

**Honest gating.** A route with unmet requirements is rendered disabled with the reason shown, rather than hidden or allowed to fail late. Run it with no configuration and TRON reports exactly why it is closed.

**Resume.** The flow is serialized to `localStorage` on every transition. Reload mid-transfer and it picks up where it left off. Unsigned wallet steps are deliberately discarded and re-prepared, never restored, because a stale blockhash or TRON reference block must never be re-presented for signature.

**Two-phase honesty.** The UI says the transfer settles first and does not call the operation atomic, because it is not.

## Configuration

Everything is optional; unset values gate their route rather than breaking the app.

| Variable | Effect |
|---|---|
| `SOLANA_RPC_URL` | Destination account checks. Defaults to the public endpoint, which is rate-limited. |
| `MAYAN_API_KEY` | Raises Mayan's rate limit. The route works without it. |
| `LAYERZERO_API_KEY` | Required for the TRON route. |
| `USDT0_TRON_ALLOWLIST` | Comma-separated USDT0 contract addresses. Also required for TRON, and the adapter refuses to prepare a transaction without it. |

## Wallets

EVM routes use any EIP-1193 wallet and switch chains before signing, because signing on a chain the quote never priced would broadcast the wrong thing. The TRON route uses TronLink.

**No Solana wallet is connected at any point.** Funding-only means the destination is a recipient, not a signer, so an address input is the whole interaction. That address is validated by actually base58-decoding it and checking for exactly 32 bytes, rather than by a character-and-length pattern: a 44-character base58 string can decode to 33 bytes and would otherwise pass. It is the one field where a mistake is unrecoverable.

`src/wallets.ts` is the only wallet code and is intentionally dependency-free. The SDK returns unsigned steps; how they are presented and submitted is the application's decision.

## Status

**No route here has completed a mainnet transfer.** Quoting has been exercised against live Circle and Solana endpoints; signing has not. Treat this as a demonstration, not a production bridge.
