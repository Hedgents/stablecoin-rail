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
4. **Wait for a dependent step to be mined before sending the next one.**
5. Pass the resulting transaction reference back into `RailFlow`.

Step 4 is not optional and is easy to miss. `WalletStep[]` is ordered, and an `approval` step must be **confirmed on chain** before the `funding` step that spends it. `eth_sendTransaction` resolves as soon as a transaction is broadcast, not when it is mined, so sending both back to back lets the transfer reach the chain first and revert with `ERC20: transfer amount exceeds allowance`. Poll `eth_getTransactionReceipt` between them and treat a non-`0x1` status as failure.

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
- Phases reached only after funding settled (`preparing-action`, `awaiting-destination-signature`) fall back to `destination-ready`, keeping the funding reference and status. The funding evidence is the record that real money already moved; rewinding past it would invite a second payment. A snapshot claiming one of these phases without funding evidence is refused as corrupt.
- Phases holding only a quote fall back to `quote-ready` while that quote is fresh, and to `idle` once it is not.
- **Unsigned wallet steps are always dropped.** They carry stale Solana blockhashes and TRON reference blocks, and re-presenting one for signature is precisely the bug this feature would otherwise introduce. Prepare again after hydrating.
- An unknown version, a malformed snapshot, or a plugin that is no longer registered fails closed.

One limitation cannot be solved inside the SDK: if a user approves in their wallet and the page dies before `markFundingSubmitted()`, the reference is unrecoverable. Hosts must persist immediately on submission.

## Settlement verification

A provider's status API usually proves that delivery happened, not how much arrived. Left alone, `FundingStatus.received` stays null and the destination action is sized from the *quoted minimum*, so a short delivery would pass unnoticed.

`RailClientOptions.settlementVerifier` closes that gap. The core consults it only where the provider left the amount unproven: a completed transfer with delivery evidence and no stated amount. A verified amount below the funding quote's guaranteed minimum throws `SETTLEMENT_BELOW_MINIMUM` and the flow stops; a foreign asset throws `SETTLEMENT_ASSET_MISMATCH`. A `null` result preserves the quoted-minimum fallback, so an indexing lag degrades rather than breaks a flow whose funds have already moved.

`@hedgents/stablecoin-rail-solana` implements this for any Solana settlement asset by reading the destination token account's balance delta.

## Remote transport

Provider credentials, target allowlists, and abuse controls must not reach a browser. `@hedgents/stablecoin-rail/remote` splits any plugin across the network without changing its contract.

```ts
// server: a Next.js route, an Express endpoint, a Worker
import { createRailHandler } from "@hedgents/stablecoin-rail/remote";
const handle = createRailHandler({ fundingProviders: [cctp, mayan] });
export async function POST(request) {
  return Response.json(await handle(await request.json()));
}

// client: the same plugin contract, no secrets
import { createRemoteFundingProvider } from "@hedgents/stablecoin-rail/remote";
const cctp = createRemoteFundingProvider({ manifest, endpoint: "/api/rail" });
```

The handler is framework-neutral: it takes an already-parsed body and returns a plain object, so it never touches HTTP itself.

Three properties are deliberate:

- **Errors keep their code.** The handler returns `{ ok: false, error }` rather than throwing, and the client rethrows a `RailPluginError` with the original code, so fail-closed behaviour survives the hop. Only the code and message cross; a cause chain that might carry credentials is dropped.
- **Authorization is the host's.** `authorize` runs before any plugin and can reject. The SDK ships no authentication, rate limiting, or order caps, because it cannot know your rules and pretending otherwise would invite integrators to assume protection they do not have.
- **The transport is contract-preserving.** A provider behind it passes the same conformance suite as the direct one, and there is a test asserting exactly that.

The manifest is supplied client-side because plugin registration is synchronous. `supports` may also be answered locally, since route shape is not secret; a local `true` is still re-checked server-side by the real plugin.
