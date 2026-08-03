# Architecture

The SDK separates capital movement from the destination application action.

```text
FundingIntent
    │
    ├── FundingProviderPlugin[]
    │      quote → minimum Solana settlement amount
    │
    ├── DestinationActionPlugin
    │      quote → minimum application output
    │
    └── RailClient
           ranks complete outcomes, not bridge marketing rates
```

## Why two plugin types

A funding provider owns source-chain approval, transfer preparation, settlement tracking, and refund reporting. A destination action owns the Solana transaction, output asset, simulation policy, and final verification.

The boundary prevents bridge-specific data from leaking into application code and prevents application-specific assumptions from becoming part of the funding layer.

## Signing boundary

Plugins return `WalletStep[]`. Each step is an EVM, Solana, or TRON request with a human-readable label. The SDK does not access wallet objects and does not submit transactions.

The application must:

1. Render the exact step.
2. Verify the connected chain and account.
3. Request the wallet signature.
4. Pass the resulting transaction reference back into `RailFlow`.

## Atomicity

The default model is intentionally two-phase:

1. Move the stablecoin and confirm it on Solana.
2. Refresh the destination quote from the confirmed amount received.
3. Prepare and sign the Solana destination action.

A future provider may expose an atomic or solver-filled destination call, but it will require a new explicit execution mode. Version 0.1 only accepts `two-phase` quotes and never infers atomicity.

## Hosted control plane

SDK plugins may call a project's own server or a hosted Hedgents endpoint. Secrets, commercial API keys, target allowlists, transaction simulation, rate limiting, and abuse controls belong on that server—not inside the browser package.

## TRON USDT route boundary

The USDT0 adapter accepts only canonical TRC-20 USDT on TRON mainnet and canonical SPL USDT on Solana mainnet. LayerZero discovery identifies the TRON contract in its 20-byte hex representation, while TRON wallets use Base58Check; the adapter pins both forms and never uses the token symbol as identity.

The adapter treats LayerZero's `SUCCEEDED` state as provider delivery evidence but leaves `FundingStatus.received` empty because the status API does not prove the exact destination balance delta. Independent verification is supplied separately by a `SettlementVerifier`; see below.

## Funding-only intents

`FundingIntent.action` is optional. Omit it when the application only needs the stablecoin delivered into the user's destination account, and the rail settles without asking for a second signature.

Ranking adapts: with an action, routes are ranked by the action's guaranteed output; without one, by the guaranteed settlement output. Action presence is a property of the intent rather than of a provider, so every quote in a batch has the same shape and quotes of different shapes can never be compared. A funding-only flow terminates at `completed` rather than `destination-ready`, so `completed` always means the user received what they asked for.

## Resuming a flow

`RailFlow.serialize()` produces a versioned, JSON-safe record; `RailClient.hydrateFlow()` restores it. The host owns storage.

Restoration is not symmetric with serialization, deliberately:

- Phases holding a real on-chain reference (`funding-pending`, `action-pending`) or a decided outcome restore as they were.
- Phases holding only a quote fall back to `quote-ready` while that quote is fresh, and to `idle` once it is not.
- **Unsigned wallet steps are always dropped.** They carry stale Solana blockhashes and TRON reference blocks, and re-presenting one for signature is precisely the bug this feature would otherwise introduce. Prepare again after hydrating.
- An unknown version, a malformed snapshot, or a plugin that is no longer registered fails closed.

One limitation cannot be solved inside the SDK: if a user approves in their wallet and the page dies before `markFundingSubmitted()`, the reference is unrecoverable. Hosts must persist immediately on submission.

## Settlement verification

A provider's status API usually proves that delivery happened, not how much arrived. Left alone, `FundingStatus.received` stays null and the destination action is sized from the *quoted minimum*, so a short delivery would pass unnoticed.

`RailClientOptions.settlementVerifier` closes that gap. The core consults it only where the provider left the amount unproven: a completed transfer with delivery evidence and no stated amount. A verified amount below the funding quote's guaranteed minimum throws `SETTLEMENT_BELOW_MINIMUM` and the flow stops; a foreign asset throws `SETTLEMENT_ASSET_MISMATCH`. A `null` result preserves the quoted-minimum fallback, so an indexing lag degrades rather than breaks a flow whose funds have already moved.

`@hedgents/stablecoin-rail-solana` implements this for any Solana settlement asset by reading the destination token account's balance delta.
