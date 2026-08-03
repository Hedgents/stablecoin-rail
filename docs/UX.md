# UX contract

The SDK is headless, but its state machine encodes the UX behavior that integrations should preserve.

## One outcome, not bridge terminology

Ask the user for the source account, amount, destination wallet, and desired Solana action. Provider names and technical route details are secondary disclosure, not the primary task.

## Rank the complete outcome

The default route is the highest guaranteed destination-action output. A low bridge fee is irrelevant when the destination swap is worse. ETA breaks a tie; brand does not.

## Tell the truth about signatures

Version 0.1 is two-phase. Before the first signature, show that the user will approve:

1. Source-chain stablecoin funding.
2. A fresh Solana destination action after settlement.

Never label the flow atomic or imply that a bridge submission guarantees a later market price.

## Eliminate dead spinners

Render the explicit `RailFlowPhase`: quoting, awaiting source signature, funding pending, destination ready, awaiting destination signature, action pending, completed, refunded, or failed. Give every pending state a transaction reference and explorer link once available.

## Recovery

Keep submitted transaction references outside ephemeral modal state. An integration should persist the selected quote identity and source reference, then resume provider status checks after reload. Durable persistence helpers are planned for a later SDK release; version 0.1 exposes the normalized references and statuses needed to implement them safely.

## Failure is a state, not a toast

Keep valid routes when one provider fails, expose failures as secondary diagnostics, and distinguish:

- no route before signing;
- source transaction rejected or reverted;
- funding pending beyond ETA;
- provider refund;
- funds settled but destination quote unavailable;
- destination transaction failed.

Once funds reach Solana, they remain the user's settlement stablecoin until the user signs the destination action.

## TRON resources

A TRC-20 source transaction consumes TRON bandwidth and energy. Before asking for a signature, show whether the wallet has sufficient TRX/resources or whether the selected provider offers gas sponsorship. Do not let an energy failure look like a bridge timeout.
