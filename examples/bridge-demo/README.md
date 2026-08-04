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
| `LAYERZERO_API_KEY` | Enables both LayerZero routes: TRON USDT and Robinhood USDG. |
| `DONATION_ADDRESS` | Shows an optional support prompt on the completed screen. Unset means it never renders. |
| `DONATION_USD` | Suggested donation amount, default 5. |
| `USDT0_TRON_ALLOWLIST` | Optional. Comma-separated USDT0 contract addresses. Without it the adapter still enforces its structural checks and surfaces the contract it will call; with it the target is pinned, which a production deployment should do. |

## Wallets

**The source wallet must be connected, because it signs.** EVM routes use any EIP-1193 wallet; the TRON route uses TronLink.

The chain is asserted per wallet step, from the step itself, rather than trusting whatever the wallet was on at connect time. Asserting only at connect is not enough: a user can change route or switch networks in between, and calldata built for one chain's contracts broadcast on another would target a different address entirely. The switch result is re-read rather than assumed, since a wallet can reject it or the user can dismiss it. Changing the selected chain also drops the connection, because an account bound to one chain or namespace is not usable on another.

**No Solana wallet is connected at any point.** Funding-only means the destination is a recipient, not a signer, so an address input is the whole interaction. That address is validated by actually base58-decoding it and checking for exactly 32 bytes, rather than by a character-and-length pattern: a 44-character base58 string can decode to 33 bytes and would otherwise pass. It is the one field where a mistake is unrecoverable.

`src/wallets.ts` is the only wallet code and is intentionally dependency-free. The SDK returns unsigned steps; how they are presented and submitted is the application's decision.

## Supporting the project

With `DONATION_ADDRESS` set, the completed screen offers an optional donation.

It sits **after** the transfer has landed, never during it. It is a separate transaction the user signs deliberately, showing the exact amount and recipient, and nothing is taken by inaction. It is not folded into the bridge, not pre-authorised, and not part of any quote, so it never affects route ranking or the guaranteed output.

This is why it is a donation rather than a fee: the service is complete and free before it is ever mentioned, and declining costs the user nothing. A prompt placed earlier, or defaulted into the payment the user is already authorising, would be a charge dressed as a request. The EU Consumer Rights Directive treats that as inferred rather than express consent and entitles the payer to reimbursement, and it is catalogued as the "sneak into basket" deceptive pattern.

EVM routes only. A TRON donation would need TRC-20 transaction building that the demo does not carry.

## Status

**No route here has completed a mainnet transfer.** Quoting has been exercised against live Circle and Solana endpoints; signing has not. Treat this as a demonstration, not a production bridge.
