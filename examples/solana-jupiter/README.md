# Server-backed funding + Jupiter example

This example shows how a browser-safe plugin calls an application's server for CCTP, Mayan, and Jupiter quote/transaction construction. API credentials remain server-side.

The server must validate provider responses and pin the exact source token, approval spender, destination USDC mint, Jupiter program set, and output mint before returning wallet steps.

The example expects these endpoints:

- `POST /funding/cctp/quote`
- `POST /funding/cctp/prepare`
- `POST /funding/cctp/status`
- `POST /funding/mayan/quote`
- `POST /funding/mayan/prepare`
- `POST /funding/mayan/status`
- `POST /actions/jupiter/quote`
- `POST /actions/jupiter/prepare`
- `POST /actions/jupiter/status`

Each endpoint returns the corresponding public SDK type. The core validates amounts, assets, expiry, and wallet-step shape; provider plugins remain responsible for cryptographic and allowlist validation.
