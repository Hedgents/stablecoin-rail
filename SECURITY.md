# Security

The SDK is non-custodial and never signs transactions. Provider and action plugins return wallet requests that the integrating application must display, validate, simulate where possible, and submit through the user's wallet.

Do not expose provider credentials in browser bundles. Route privileged quote preparation through an authenticated server endpoint.

Before enabling a plugin in production:

1. Pin every contract, token mint, chain, spender, and destination program it may return.
2. Reject expired quotes and outputs below the quoted minimum.
3. Simulate destination transactions and verify token-program ownership, including Token-2022.
4. Treat a submitted signature as pending until chain state confirms settlement.
5. Implement refunds, timeouts, and resumable status checks.
6. Show every approval, amount, token, recipient, and irreversible action before signing.

Please report vulnerabilities privately to security@hedgents.com. Do not open a public issue until a fix is available.
