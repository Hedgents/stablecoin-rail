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

The adapter treats LayerZero's `SUCCEEDED` state as provider delivery evidence but leaves `FundingStatus.received` empty because the status API does not prove the exact destination balance delta. The destination action therefore remains sized from the quoted minimum until an integration adds independent Solana receipt verification.
