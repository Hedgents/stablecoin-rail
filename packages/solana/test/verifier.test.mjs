import assert from "node:assert/strict";
import test from "node:test";
import { createSolanaSettlementVerifier, TOKEN_2022_PROGRAM_ID } from "../dist/index.js";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OWNER = "DestinationWallet111111111111111111111111111";
const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const solanaUsdc = {
  chainId: "solana:mainnet",
  assetId: `solana:mainnet/spl:${MINT}`,
  symbol: "USDC",
  decimals: 6,
};

const context = { now: () => Date.parse("2026-08-03T12:00:00.000Z") };

function request(overrides = {}) {
  return {
    intent: {
      destination: {
        account: { chainId: "solana:mainnet", address: OWNER },
        settlementAsset: solanaUsdc,
      },
    },
    quote: { minimumOutput: { asset: solanaUsdc, amountBaseUnits: "99000000" } },
    status: {
      state: "completed",
      destinationReference: { chainId: "solana:mainnet", txId: "solsig", submittedAt: "" },
    },
    ...overrides,
  };
}

function rpc(result) {
  return async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      headers: { "content-type": "application/json" },
    });
}

function transaction({ pre, post, owner = OWNER, mint = MINT, programId = SPL, err = null }) {
  return {
    meta: {
      err,
      preTokenBalances:
        pre === null
          ? []
          : [{ accountIndex: 3, mint, owner, programId, uiTokenAmount: { amount: pre } }],
      postTokenBalances: [
        { accountIndex: 3, mint, owner, programId, uiTokenAmount: { amount: post } },
      ],
    },
  };
}

test("returns the token balance delta", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    fetch: rpc(transaction({ pre: "1000000", post: "100500000" })),
  });
  const received = await verifier.verify(request(), context);
  assert.equal(received.amountBaseUnits, "99500000");
  assert.equal(received.asset.assetId, solanaUsdc.assetId);
});

test("treats a first-time recipient with no prior balance as a full delta", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    fetch: rpc(transaction({ pre: null, post: "99500000" })),
  });
  assert.equal((await verifier.verify(request(), context)).amountBaseUnits, "99500000");
});

test("returns null when the transaction is not indexed yet", async () => {
  const verifier = createSolanaSettlementVerifier({ rpcUrl: "https://rpc.test", fetch: rpc(null) });
  assert.equal(await verifier.verify(request(), context), null);
});

test("returns null for a failed transaction", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    fetch: rpc(transaction({ pre: "0", post: "99500000", err: { InstructionError: [0, "Custom"] } })),
  });
  assert.equal(await verifier.verify(request(), context), null);
});

test("returns null when no balance entry matches the owner", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    fetch: rpc(
      transaction({ pre: "0", post: "99500000", owner: "SomeoneElse1111111111111111111111111111111" }),
    ),
  });
  assert.equal(await verifier.verify(request(), context), null);
});

test("returns null when no balance entry matches the mint", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    fetch: rpc(transaction({ pre: "0", post: "99500000", mint: "AnotherMint1111111111111111111111111111111" })),
  });
  assert.equal(await verifier.verify(request(), context), null);
});

test("returns null when the token program is not the expected one", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    fetch: rpc(transaction({ pre: "0", post: "99500000", programId: TOKEN_2022_PROGRAM_ID })),
  });
  assert.equal(await verifier.verify(request(), context), null);
});

test("accepts a Token-2022 delivery when configured for it", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    fetch: rpc(transaction({ pre: "0", post: "99500000", programId: TOKEN_2022_PROGRAM_ID })),
  });
  assert.equal((await verifier.verify(request(), context)).amountBaseUnits, "99500000");
});

test("returns null on a balance that did not increase", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    fetch: rpc(transaction({ pre: "99500000", post: "99500000" })),
  });
  assert.equal(await verifier.verify(request(), context), null);
});

test("returns null without a Solana destination reference", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    fetch: rpc(transaction({ pre: "0", post: "99500000" })),
  });
  const status = { state: "completed", destinationReference: null };
  assert.equal(await verifier.verify(request({ status }), context), null);
});

test("returns null when the RPC call fails", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    fetch: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(await verifier.verify(request(), context), null);
});

test("returns null on a non-OK RPC response", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    fetch: async () => new Response("rate limited", { status: 429 }),
  });
  assert.equal(await verifier.verify(request(), context), null);
});
