# Plugin authoring

Every plugin declares a stable ID, semantic version, API version, kind, and optional homepage. IDs must be unique within a `RailClient`.

## Funding provider

Implement:

- `supports(intent)` — a fast capability check.
- `quote(intent, context)` — return exact input, expected output, minimum output, fees, ETA, and expiry.
- `prepare({ intent, quote }, context)` — return one or more unsigned wallet steps.
- `getStatus({ intent, quote, reference }, context)` — return pending, completed, refunded, or failed using provider or chain evidence.

Provider-specific quote data belongs in `opaqueData`. Revalidate it before preparing a transaction. Never trust a quote merely because it has the correct TypeScript shape.

## Destination action

Implement:

- `supports({ intent, fundingQuote })`.
- `quote(...)` — quote the application outcome using the funding minimum, not only its optimistic output.
- `prepare(...)` — return the Solana wallet step or steps.
- `getStatus(...)` — verify the resulting signature and output. This method is optional when the host verifies completion itself.

For token actions, pin the mint and token program. Detect classic SPL Token versus Token-2022 and simulate before signing.

The core requests the action quote twice for non-atomic UX: once to compare complete routes, and again after funding is confirmed. The second quote uses the amount reported as received, when available, and is the only quote used to prepare the destination wallet request.

## Quote ranking

The core compares the guaranteed output the user actually receives: the destination action's minimum output when the intent has an action, and the funding route's minimum settlement output when it does not. All successful quotes for a single intent must return the same output asset and decimals. The higher guaranteed output wins; ETA is the tie-breaker.

## Proving your plugin

Do not rely on your own test doubles to tell you the contract is satisfied. The core ships an executable version of it:

```ts
import { fundingProviderConformance } from "@hedgents/stablecoin-rail/testing";

for (const item of fundingProviderConformance({
  plugin: myProvider,
  supportedIntent,     // an intent you serve
  unsupportedIntent,   // an intent on a chain or asset you must decline
  now: () => FIXED_TIME,
})) {
  test(item.name, () => item.run());
}
```

`destinationActionConformance` does the same for destination actions. Cases are returned as plain `{ name, run }` objects rather than registered with a test runner, so any framework works.

The suite asserts what the core actually depends on: `supports()` declines foreign intents, `quote()` returns `null` rather than throwing for them, the quoted input matches the intent exactly, `minimumOutput` never exceeds `expectedOutput`, execution stays `two-phase`, `prepare()` emits valid wallet steps, and `getStatus()` rejects a reference from an unrelated chain. Stub your upstream HTTP layer; no case performs network I/O.

If a case fails, fix the plugin. If you believe a case asserts something the contract does not require, open an issue rather than working around it.

## Error behavior

Throw `RailPluginError` for a known provider failure. One plugin failure does not discard valid quotes from other providers; it appears in `QuoteBatch.failures` so the UI can be honest without becoming unusable.
