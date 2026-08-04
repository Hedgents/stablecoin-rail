import {
  RailPluginError,
  defineFundingProvider,
  type FundingIntent,
  type FundingQuote,
  type FundingQuoteDraft,
  type FundingStatus,
  type WalletStep,
} from "@hedgents/stablecoin-rail";
import { deriveAssociatedTokenAddress } from "@hedgents/stablecoin-rail-solana";
import { encodeApprove } from "./approve.js";
import type { MayanOptions, MayanQuote, MayanSdk } from "./types.js";

const PLUGIN_ID = "mayan-bnb-solana";
const OPAQUE_SCHEMA = "hedgents.mayan.bnb-solana.v1";
const EXPLORER = "https://explorer-api.mayan.finance";

/** Mayan's single entry point, identical on every EVM chain. */
export const MAYAN_FORWARDER = "0x337685fdaB40D39bd02028545a4FfA7D287cC3E2";

export const BNB_CHAIN_ID = "eip155:56";
export const BNB_NUMERIC_CHAIN_ID = 56;
/** Binance-Peg USDC. NOT a native Circle USDC deployment. */
export const BNB_PEG_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const INTEGER = /^\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string): never {
  throw new RailPluginError(PLUGIN_ID, code, message);
}

/**
 * Mayan reports output amounts as human-readable JS numbers. Converting to base
 * units must round DOWN, because this figure becomes a guaranteed minimum and
 * claiming more than the protocol guarantees is the unsafe direction.
 *
 * Truncating the raw double is wrong, though: 99.1 is not exactly
 * representable, so it prints as 99.09999999999999 and a naive floor loses a
 * base unit on a perfectly ordinary quote. Binary noise is therefore absorbed
 * by rounding two decimal places beyond what we keep, and only then truncated.
 *
 * The absolute error of a double grows with magnitude, so amounts far above
 * ~1e9 units cannot be converted exactly. That is a limitation of an API that
 * sends money as a JS number, not of this conversion.
 */
export function floorToBaseUnits(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    fail("INVALID_UPSTREAM_AMOUNT", "Mayan returned a non-finite output amount.");
  }
  const text = value.toFixed(Math.min(decimals + 2, 20));
  const [whole = "0", fraction = ""] = text.split(".");
  let units = BigInt(whole + fraction.slice(0, decimals).padEnd(decimals, "0"));
  // toFixed rounds to nearest, and within ~5e-(decimals+2) below a base-unit
  // boundary the carry propagates INTO the kept digits, yielding one unit MORE
  // than the true floor. Claiming more than the protocol guarantees is the
  // unsafe direction, so step back down whenever the result exceeds the input.
  if (units > 0n && Number(units) / 10 ** decimals > value) units -= 1n;
  return units;
}

export function createMayanBnbToSolana(options: MayanOptions) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const explorerBaseUrl = (options.explorerBaseUrl ?? EXPLORER).replace(/\/$/, "");
  const sourceToken = options.sourceToken ?? BNB_PEG_USDC;
  const settlementMint = options.settlementMint ?? SOLANA_USDC_MINT;
  const solanaChainId = options.solanaChainId ?? "solana:mainnet";
  const ttlSeconds = options.quoteTtlSeconds ?? 60;
  const sdk = options.sdk;

  function supportsRoute(intent: FundingIntent): boolean {
    return (
      intent.source.account.chainId === BNB_CHAIN_ID &&
      EVM_ADDRESS.test(intent.source.account.address) &&
      intent.source.asset.chainId === BNB_CHAIN_ID &&
      intent.source.asset.assetId.toLowerCase() ===
        `${BNB_CHAIN_ID}/erc20:${sourceToken.toLowerCase()}` &&
      intent.destination.account.chainId === solanaChainId &&
      SOLANA_ADDRESS.test(intent.destination.account.address) &&
      intent.destination.settlementAsset.assetId.endsWith(`:${settlementMint}`)
    );
  }

  async function tokenAccountBalance(account: string, signal?: AbortSignal): Promise<bigint | null> {
    const response = await fetchImpl(options.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "rail-mayan",
        method: "getTokenAccountBalance",
        params: [account, { commitment: "confirmed" }],
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) fail("RPC_UNAVAILABLE", `The Solana RPC returned ${response.status}.`);
    const payload: unknown = await response.json();
    if (!isRecord(payload)) fail("RPC_UNAVAILABLE", "The Solana RPC returned a malformed response.");
    // A missing account answers with JSON-RPC error -32602, not a null
    // result. ONLY that error means "no account yet": transient node errors
    // arrive over HTTP 200 in the same envelope, and mistaking one for a
    // missing account would zero the delivery baseline for a funded account.
    if (payload.error) {
      const error = payload.error;
      if (
        isRecord(error) &&
        error.code === -32602 &&
        typeof error.message === "string" &&
        /could not find account/i.test(error.message)
      ) {
        return null;
      }
      const message = isRecord(error) && typeof error.message === "string" ? error.message : "an unspecified error";
      fail("RPC_UNAVAILABLE", `The Solana RPC failed the balance read: ${message}.`);
    }
    // A success payload without a readable amount is ambiguous, and ambiguity
    // must not read as an empty account.
    const result = payload.result;
    if (!isRecord(result) || !isRecord(result.value)) {
      fail("RPC_UNAVAILABLE", "The Solana RPC returned a balance without a value.");
    }
    const amount = result.value.amount;
    if (typeof amount !== "string" || !INTEGER.test(amount)) {
      fail("RPC_UNAVAILABLE", "The Solana RPC returned an unreadable balance amount.");
    }
    return BigInt(amount);
  }

  function chooseQuote(quotes: MayanQuote[], intent: FundingIntent): MayanQuote | null {
    const decimals = intent.destination.settlementAsset.decimals;
    const usable = quotes.filter(
      (quote) =>
        isRecord(quote) &&
        quote.effectiveAmountIn64 === intent.inputAmountBaseUnits &&
        typeof quote.minReceived === "number" &&
        typeof quote.expectedAmountOut === "number" &&
        quote.minReceived > 0 &&
        quote.expectedAmountOut >= quote.minReceived &&
        // Never accept a route that would land a different mint.
        quote.toToken?.contract === settlementMint,
    );
    usable.sort((left, right) => {
      const l = floorToBaseUnits(left.minReceived, decimals);
      const r = floorToBaseUnits(right.minReceived, decimals);
      if (l !== r) return l > r ? -1 : 1;
      return (left.etaSeconds ?? 0) - (right.etaSeconds ?? 0);
    });
    return usable[0] ?? null;
  }

  function requirePins(intent: FundingIntent, quote: FundingQuote) {
    if (!isRecord(quote.opaqueData)) {
      fail("INVALID_QUOTE_DATA", "The Mayan quote is missing its pinned data.");
    }
    const data = quote.opaqueData;
    const pins: Record<string, unknown> = {
      schema: OPAQUE_SCHEMA,
      sourceToken,
      settlementMint,
      sourceSigner: intent.source.account.address,
      destinationWallet: intent.destination.account.address,
      sourceAmount: intent.inputAmountBaseUnits,
    };
    for (const [key, expected] of Object.entries(pins)) {
      if (data[key] !== expected) fail("QUOTE_PIN_MISMATCH", `The prepared Mayan quote changed ${key}.`);
    }
    return data;
  }

  return defineFundingProvider({
    manifest: {
      id: PLUGIN_ID,
      // Named so no interface can present this as native Circle CCTP.
      name: "Mayan adapter (Binance-Peg USDC)",
      version: "0.1.0",
      apiVersion: 1,
      kind: "funding-provider",
      homepage: "https://mayan.finance",
    },
    supports: supportsRoute,

    quote: async (intent, context): Promise<FundingQuoteDraft | null> => {
      if (!supportsRoute(intent)) return null;
      const decimals = intent.destination.settlementAsset.decimals;
      const wallet = intent.destination.account.address;

      const quotes = await sdk.fetchQuote({
        amountIn64: intent.inputAmountBaseUnits,
        fromToken: sourceToken,
        fromChain: "bsc",
        toToken: settlementMint,
        toChain: "solana",
        slippageBps: intent.slippageBps,
        destinationAddress: wallet,
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      });
      const selected = chooseQuote(Array.isArray(quotes) ? quotes : [], intent);
      if (!selected) return null;

      const minimumOutput = floorToBaseUnits(selected.minReceived, decimals);
      const expectedOutput = floorToBaseUnits(selected.expectedAmountOut, decimals);
      if (minimumOutput <= 0n) fail("NO_EXECUTABLE_OUTPUT", "Mayan returned no usable minimum output.");

      const destinationTokenAccount = deriveAssociatedTokenAddress(wallet, settlementMint);
      const baseline = await tokenAccountBalance(destinationTokenAccount, context.signal);
      const quotedAt = context.now();

      return {
        id: `mayan-${selected.type ?? "route"}-${quotedAt}`,
        input: { asset: intent.source.asset, amountBaseUnits: intent.inputAmountBaseUnits },
        expectedOutput: {
          asset: intent.destination.settlementAsset,
          amountBaseUnits: (expectedOutput < minimumOutput ? minimumOutput : expectedOutput).toString(),
        },
        minimumOutput: {
          asset: intent.destination.settlementAsset,
          amountBaseUnits: minimumOutput.toString(),
        },
        fees: [],
        etaSeconds:
          typeof selected.etaSeconds === "number" && Number.isFinite(selected.etaSeconds)
            ? Math.ceil(selected.etaSeconds)
            : 0,
        expiresAt: new Date(quotedAt + ttlSeconds * 1_000).toISOString(),
        executionMode: "two-phase",
        opaqueData: {
          schema: OPAQUE_SCHEMA,
          // Surfaced so no UI can imply this is a like-for-like USDC transfer.
          disclosure:
            "Adapter route. Binance-Peg USDC on BNB Chain is issued by Binance, not Circle, " +
            "and Mayan swaps it for native Solana USDC. This is not Circle CCTP.",
          routeType: selected.type ?? null,
          forwarder: MAYAN_FORWARDER,
          sourceToken,
          settlementMint,
          sourceSigner: intent.source.account.address,
          destinationWallet: wallet,
          destinationTokenAccount,
          sourceAmount: intent.inputAmountBaseUnits,
          baselineBaseUnits: (baseline ?? 0n).toString(),
          minimumOutput: minimumOutput.toString(),
          mayanQuote: selected as unknown as Record<string, never>,
        },
      };
    },

    prepare: async ({ intent, quote }): Promise<WalletStep[]> => {
      const data = requirePins(intent, quote);
      const mayanQuote = data.mayanQuote;
      if (!isRecord(mayanQuote)) fail("INVALID_QUOTE_DATA", "The Mayan quote payload is missing.");

      const built = await sdk.getSwapFromEvmTxPayload(
        mayanQuote as unknown as MayanQuote,
        intent.source.account.address,
        intent.destination.account.address,
        null,
        intent.source.account.address,
        BNB_NUMERIC_CHAIN_ID,
        null,
        null,
        options.apiKey ? { apiKey: options.apiKey } : undefined,
      );

      const to = typeof built.to === "string" ? built.to : "";
      const callData = typeof built.data === "string" ? built.data : "";
      // Pin the target. A quote-driven SDK must never send us somewhere else.
      if (to.toLowerCase() !== MAYAN_FORWARDER.toLowerCase()) {
        fail("UNEXPECTED_TARGET", "Mayan returned a transaction outside its Forwarder contract.");
      }
      if (!/^0x[0-9a-fA-F]*$/.test(callData) || callData.length < 10) {
        fail("INVALID_UPSTREAM_RESPONSE", "Mayan returned malformed call data.");
      }
      const value = built.value == null ? 0n : BigInt(built.value.toString());
      // An ERC-20 route must never move native BNB.
      if (value !== 0n) {
        fail("UNEXPECTED_NATIVE_VALUE", "Mayan asked to send native BNB on an ERC-20 route.");
      }

      return [
        {
          id: "mayan-approve",
          kind: "approval",
          chainId: BNB_CHAIN_ID,
          label: `Approve exactly ${intent.inputAmountBaseUnits} Binance-Peg USDC`,
          description: "Exact-amount allowance for Mayan's Forwarder. Never unlimited.",
          request: {
            namespace: "evm",
            chainId: BNB_CHAIN_ID,
            numericChainId: BNB_NUMERIC_CHAIN_ID,
            to: sourceToken as `0x${string}`,
            data: encodeApprove(MAYAN_FORWARDER, BigInt(intent.inputAmountBaseUnits)),
            value: "0",
          },
        },
        {
          id: "mayan-forward",
          kind: "funding",
          chainId: BNB_CHAIN_ID,
          label: "Swap Binance-Peg USDC to native Solana USDC",
          description: "Adapter route through Mayan's Forwarder. Not Circle CCTP.",
          request: {
            namespace: "evm",
            chainId: BNB_CHAIN_ID,
            numericChainId: BNB_NUMERIC_CHAIN_ID,
            to: MAYAN_FORWARDER as `0x${string}`,
            data: callData as `0x${string}`,
            value: "0",
          },
        },
      ];
    },

    getStatus: async ({ intent, quote, reference }, context): Promise<FundingStatus> => {
      const data = requirePins(intent, quote);
      if (reference.chainId !== BNB_CHAIN_ID) {
        fail("REFERENCE_CHAIN_MISMATCH", "The Mayan source reference must be a BNB Chain transaction.");
      }
      if (!TX_HASH.test(reference.txId)) {
        fail("INVALID_REFERENCE", "The Mayan source reference must be a 32-byte transaction hash.");
      }
      const checkedAt = new Date(context.now()).toISOString();
      const base = { reference, destinationReference: null, received: null, checkedAt } as const;

      const response = await fetchImpl(
        `${explorerBaseUrl}/v3/swap/trx/${encodeURIComponent(reference.txId)}`,
        { headers: { accept: "application/json" }, ...(context.signal ? { signal: context.signal } : {}) },
      );
      if (response.status === 404) {
        return { ...base, state: "pending", detail: "Mayan has not indexed this swap yet." };
      }
      if (!response.ok) {
        fail("STATUS_SERVICE_UNAVAILABLE", `Mayan's explorer returned ${response.status}.`);
      }
      const payload: unknown = await response.json();
      const status = isRecord(payload) && typeof payload.status === "string" ? payload.status : "";

      // Mayan does not publish an exhaustive status enum, so only the refund and
      // failure families are matched by name. Completion is proven on-chain
      // instead of inferred from a string we cannot enumerate.
      if (/REFUND/i.test(status)) {
        return { ...base, state: "refunded", detail: `Mayan reports the swap was refunded (${status}).` };
      }
      if (/FAIL|CANCEL/i.test(status)) {
        return { ...base, state: "failed", detail: `Mayan reports the swap failed (${status}).` };
      }

      const account = data.destinationTokenAccount;
      const baselineRaw = data.baselineBaseUnits;
      const minimumRaw = data.minimumOutput;
      if (typeof account !== "string" || typeof baselineRaw !== "string" || typeof minimumRaw !== "string") {
        fail("INVALID_QUOTE_DATA", "The Mayan quote is missing its delivery baseline.");
      }
      const balance = await tokenAccountBalance(account, context.signal);
      if (balance === null || balance - BigInt(baselineRaw) < BigInt(minimumRaw)) {
        return {
          ...base,
          state: "pending",
          detail: status
            ? `Mayan reports ${status}; native USDC has not reached the destination account yet.`
            : "The swap is in flight.",
        };
      }
      return { ...base, state: "completed", detail: "Native USDC delivered to the destination account." };
    },
  });
}

export type { MayanOptions, MayanSdk };
