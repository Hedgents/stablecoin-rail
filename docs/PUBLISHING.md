# Publishing checklist

The packages are configured for public npm publishing with provenance, but publishing is intentionally not automated yet.

Before the first release:

1. Confirm ownership of the `@hedgents` npm scope.
2. Create the public GitHub repository and add its URL to both package manifests.
3. Replace placeholder security contact details if needed.
4. Run targeted Ethereum → Solana, BNB → Solana, and TRON USDT → Solana USDT mainnet tests with small values.
5. Add audited official provider adapters.
6. Obtain an independent review of wallet-request validation and status recovery.
7. Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run pack:check`.
8. Enable a trusted-publisher workflow for npm provenance.
9. Publish an `0.1.0-alpha.1` prerelease before declaring API stability.

Recommended initial packages:

```bash
npm publish --workspace=@hedgents/stablecoin-rail --tag alpha
npm publish --workspace=@hedgents/stablecoin-rail-layerzero --tag alpha
npm publish --workspace=@hedgents/stablecoin-rail-react --tag alpha
```
