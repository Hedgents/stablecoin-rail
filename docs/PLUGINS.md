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

The core compares the destination action's minimum output. All successful action quotes must return the same output asset and decimals for a single intent. The higher guaranteed output wins; ETA is the tie-breaker.

## Error behavior

Throw `RailPluginError` for a known provider failure. One plugin failure does not discard valid quotes from other providers; it appears in `QuoteBatch.failures` so the UI can be honest without becoming unusable.
