# Contributing

Hedgents Stablecoin Rail is designed around small, auditable plugins. Contributions should preserve these rules:

- The SDK never holds keys or signs for users.
- Provider plugins move settlement assets; action plugins consume them on the destination chain.
- Chain, asset, program, contract, spender, and recipient identifiers must be explicit.
- Quotes must include minimum output and expiry.
- Status is verified from provider or chain state, never inferred from a client callback.
- Provider-specific objects stay inside `opaqueData` and plugin implementations.

Run `npm test`, `npm run typecheck`, and `npm run build` before opening a pull request.
