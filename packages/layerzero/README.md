# LayerZero adapter

Server-side funding adapter for moving canonical USDT from TRON into canonical
USDT on Solana through LayerZero's Value Transfer API and USDT0 Legacy Mesh.

The adapter pins both token identities:

- TRON wallet identity: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`
- LayerZero TRON identity: `0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C`
- Solana mint: `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`

```ts
import { createLayerZeroUsdt0TronToSolana } from "@hedgents/stablecoin-rail-layerzero";

const provider = createLayerZeroUsdt0TronToSolana({
  apiKey: process.env.LAYERZERO_TRANSFER_API_KEY!,
  validateTronTransaction: ({ transaction, intent, quote }) => {
    // Decode the TriggerSmartContract payload and verify its contract and
    // transfer recipient against your independently maintained USDT0 allowlist.
  },
});
```

Keep the API key on a server. The adapter builds unsigned TRON wallet requests;
it never accesses a wallet, signs, or broadcasts. Preparation fails unless a
host transaction policy is provided. USDT0 advises direct smart-contract
integrators to coordinate migrations with its team, so the SDK intentionally
does not freeze a third-party routing target forever.

## Contract allowlists

`validateTronTransaction` is optional hardening rather than a precondition.

Without it the TRON adapter still refuses anything structurally wrong: a pre-signed envelope, a call that is not `TriggerSmartContract`, any movement of TRX or a TRC-10 token, or a signer that does not match the intent. It also surfaces the contract addresses the envelope will call, because a TRON transaction buries its target where neither a user nor a wallet UI will notice it.

Supply a policy to additionally pin the target, which a production deployment should do. USDT0 migrates Legacy Mesh contracts wholesale, so treat any pinned list as something to re-verify rather than set once.
