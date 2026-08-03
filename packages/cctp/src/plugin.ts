import {
  RailPluginError,
  defineFundingProvider,
  type AssetDescriptor,
  type FundingIntent,
  type FundingQuote,
  type FundingQuoteDraft,
  type FundingStatus,
  type TransactionReference,
  type WalletStep,
} from "@hedgents/stablecoin-rail";
import { deriveAssociatedTokenAddress, toBytes32 } from "@hedgents/stablecoin-rail-solana";
import { assertChecksumAddress, encodeApprove, encodeDepositForBurnWithHook } from "./abi.js";
import { protocolFee, selectFeeTier } from "./fees.js";
import { buildSolanaForwardHook } from "./hook.js";
import type { CctpOptions, CctpSourceChain } from "./types.js";

const PLUGIN_ID = "circle-cctp-v2-solana";
const OPAQUE_SCHEMA = "hedgents.cctp.v2.evm-solana.v1";
const DEFAULT_API = "https://iris-api.circle.com";
const DEFAULT_FINALITY = 1000;
const DEFAULT_TTL_SECONDS = 90;
/** One USDC of headroom, so a quote cannot be consumed entirely by fees. */
const DEFAULT_BUFFER = 1_000_000n;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as const;
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

function sameAsset(left: AssetDescriptor, right: AssetDescriptor) {
  return (
    left.chainId === right.chainId &&
    left.assetId === right.assetId &&
    left.decimals === right.decimals
  );
}

function usdcAssetFor(chain: CctpSourceChain): { chainId: string; assetId: string } {
  return {
    chainId: chain.chainId,
    assetId: `${chain.chainId}/erc20:${chain.usdcAddress.toLowerCase()}`,
  };
}

export function createCctpToSolana(options: CctpOptions) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API).replace(/\/$/, "");
  const finality = options.finalityThreshold ?? DEFAULT_FINALITY;
  const ttlSeconds = options.quoteTtlSeconds ?? DEFAULT_TTL_SECONDS;
  const buffer = options.minimumBufferBaseUnits ?? DEFAULT_BUFFER;
  const solana = options.solana;

  if (options.sources.length === 0) {
    throw new RailPluginError(PLUGIN_ID, "NO_SOURCE_CHAINS", "Configure at least one CCTP source chain.");
  }
  // Validate configuration once, loudly, rather than at signing time.
  for (const source of options.sources) {
    assertChecksumAddress(source.usdcAddress, `${source.chainId} usdcAddress`);
    assertChecksumAddress(source.tokenMessengerV2, `${source.chainId} tokenMessengerV2`);
    if (!Number.isInteger(source.cctpDomain) || source.cctpDomain < 0) {
      throw new RailPluginError(PLUGIN_ID, "INVALID_DOMAIN", `${source.chainId} has an invalid CCTP domain.`);
    }
    if (source.chainId !== `eip155:${source.numericChainId}`) {
      throw new RailPluginError(PLUGIN_ID, "CHAIN_ID_MISMATCH", `${source.chainId} disagrees with its numeric chain ID.`);
    }
  }
  if (!SOLANA_ADDRESS.test(solana.usdcMint)) {
    throw new RailPluginError(PLUGIN_ID, "INVALID_SETTLEMENT_MINT", "The Solana USDC mint is not a base58 address.");
  }

  const sources = new Map(options.sources.map((source) => [source.chainId, source]));

  function resolveSource(intent: FundingIntent): CctpSourceChain | null {
    const source = sources.get(intent.source.account.chainId);
    if (!source) return null;
    if (!EVM_ADDRESS.test(intent.source.account.address)) return null;
    const expected = usdcAssetFor(source);
    if (
      intent.source.asset.chainId !== expected.chainId ||
      intent.source.asset.assetId.toLowerCase() !== expected.assetId
    ) {
      return null;
    }
    return source;
  }

  function supportsRoute(intent: FundingIntent): boolean {
    if (!resolveSource(intent)) return false;
    if (intent.destination.account.chainId !== solana.chainId) return false;
    if (!SOLANA_ADDRESS.test(intent.destination.account.address)) return false;
    return intent.destination.settlementAsset.assetId.endsWith(`:${solana.usdcMint}`);
  }

  /**
   * Current balance of a token account, or `null` when it does not exist.
   *
   * Solana answers `getTokenAccountBalance` for a missing account with a
   * JSON-RPC *error* rather than a null result, so an error payload is read as
   * "no account yet" rather than propagated. A transport-level failure still
   * throws, because that is a different condition.
   */
  async function tokenAccountBalance(account: string, signal?: AbortSignal): Promise<bigint | null> {
    const response = await fetchImpl(options.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "rail-cctp",
        method: "getTokenAccountBalance",
        params: [account, { commitment: "confirmed" }],
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) fail("RPC_UNAVAILABLE", `The Solana RPC returned ${response.status}.`);
    const payload: unknown = await response.json();
    if (!isRecord(payload)) fail("RPC_UNAVAILABLE", "The Solana RPC returned a malformed response.");
    if (payload.error) return null;
    const result = payload.result;
    if (!isRecord(result) || !isRecord(result.value)) return null;
    const amount = result.value.amount;
    return typeof amount === "string" && INTEGER.test(amount) ? BigInt(amount) : null;
  }

  function requirePins(intent: FundingIntent, quote: FundingQuote) {
    if (!isRecord(quote.opaqueData)) {
      fail("INVALID_QUOTE_DATA", "The CCTP quote is missing its pinned data.");
    }
    const data = quote.opaqueData;
    const source = resolveSource(intent);
    if (!source) fail("UNSUPPORTED_ROUTE", "This intent is not a configured CCTP route.");
    const pins: Record<string, unknown> = {
      schema: OPAQUE_SCHEMA,
      sourceDomain: source.cctpDomain,
      destinationDomain: solana.cctpDomain,
      tokenMessengerV2: source.tokenMessengerV2,
      burnToken: source.usdcAddress,
      sourceAmount: intent.inputAmountBaseUnits,
      destinationWallet: intent.destination.account.address,
    };
    for (const [key, expected] of Object.entries(pins)) {
      if (data[key] !== expected) {
        fail("QUOTE_PIN_MISMATCH", `The prepared CCTP quote changed ${key}.`);
      }
    }
    return { data, source };
  }

  return defineFundingProvider({
    manifest: {
      id: PLUGIN_ID,
      name: "Circle CCTP V2",
      version: "0.1.0",
      apiVersion: 1,
      kind: "funding-provider",
      homepage: "https://developers.circle.com/cctp",
    },
    supports: supportsRoute,

    quote: async (intent, context): Promise<FundingQuoteDraft | null> => {
      const source = supportsRoute(intent) ? resolveSource(intent) : null;
      if (!source) return null;

      const amount = BigInt(intent.inputAmountBaseUnits);
      const wallet = intent.destination.account.address;
      const destinationTokenAccount = deriveAssociatedTokenAddress(wallet, solana.usdcMint);
      const baseline = await tokenAccountBalance(destinationTokenAccount, context.signal);
      const recipientSetupIncluded = baseline === null;

      const query = new URLSearchParams({ forward: "true" });
      if (recipientSetupIncluded) query.set("includeRecipientSetup", "true");
      const feeResponse = await fetchImpl(
        `${apiBaseUrl}/v2/burn/USDC/fees/${source.cctpDomain}/${solana.cctpDomain}?${query}`,
        { headers: { accept: "application/json" }, ...(context.signal ? { signal: context.signal } : {}) },
      );
      if (!feeResponse.ok) {
        fail("FEE_SERVICE_UNAVAILABLE", `Circle's fee service returned ${feeResponse.status}.`);
      }
      const tier = selectFeeTier(await feeResponse.json(), finality);
      const maxFee = tier.forwardFee + protocolFee(amount, tier.minimumFeeBps);
      if (amount <= maxFee + buffer) {
        fail("AMOUNT_BELOW_FEES", "This amount does not clear the live CCTP forwarding fee.");
      }

      const minimumOutput = (amount - maxFee).toString();
      const hookData = buildSolanaForwardHook(wallet, recipientSetupIncluded);
      const quotedAt = context.now();

      return {
        id: `cctp-${source.cctpDomain}-${solana.cctpDomain}-${quotedAt}`,
        input: { asset: intent.source.asset, amountBaseUnits: intent.inputAmountBaseUnits },
        expectedOutput: {
          asset: intent.destination.settlementAsset,
          amountBaseUnits: minimumOutput,
        },
        minimumOutput: {
          asset: intent.destination.settlementAsset,
          amountBaseUnits: minimumOutput,
        },
        fees: [
          {
            type: "forwarding",
            label: "Circle Forwarding Service",
            amount: {
              asset: intent.destination.settlementAsset,
              amountBaseUnits: tier.forwardFee.toString(),
            },
          },
          {
            type: "provider",
            label: "CCTP protocol fee",
            amount: {
              asset: intent.destination.settlementAsset,
              amountBaseUnits: protocolFee(amount, tier.minimumFeeBps).toString(),
            },
          },
        ],
        etaSeconds: tier.finalityThreshold === 1000 ? 30 : 900,
        expiresAt: new Date(quotedAt + ttlSeconds * 1_000).toISOString(),
        executionMode: "two-phase",
        // Everything a host needs to render full cost and recipient disclosure
        // without a second call into this provider.
        opaqueData: {
          schema: OPAQUE_SCHEMA,
          sourceDomain: source.cctpDomain,
          destinationDomain: solana.cctpDomain,
          tokenMessengerV2: source.tokenMessengerV2,
          burnToken: source.usdcAddress,
          sourceAmount: intent.inputAmountBaseUnits,
          destinationWallet: wallet,
          destinationTokenAccount,
          mintRecipient: toBytes32(destinationTokenAccount),
          destinationCaller: ZERO_BYTES32,
          recipientSetupIncluded,
          baselineBaseUnits: (baseline ?? 0n).toString(),
          forwardFee: tier.forwardFee.toString(),
          protocolFee: protocolFee(amount, tier.minimumFeeBps).toString(),
          maxFee: maxFee.toString(),
          finalityThreshold: tier.finalityThreshold,
          minimumOutput,
          hookData,
        },
      };
    },

    prepare: async ({ intent, quote }): Promise<WalletStep[]> => {
      const { data, source } = requirePins(intent, quote);
      const amount = BigInt(intent.inputAmountBaseUnits);
      const mintRecipient = data.mintRecipient;
      const hookData = data.hookData;
      const maxFee = data.maxFee;
      const finalityThreshold = data.finalityThreshold;
      if (
        typeof mintRecipient !== "string" ||
        typeof hookData !== "string" ||
        typeof maxFee !== "string" ||
        !Number.isInteger(finalityThreshold)
      ) {
        fail("INVALID_QUOTE_DATA", "The CCTP quote is missing prepared transaction data.");
      }

      const chainId = `eip155:${source.numericChainId}`;
      return [
        {
          id: "cctp-approve",
          kind: "approval",
          chainId,
          label: `Approve exactly ${intent.inputAmountBaseUnits} USDC`,
          description: "Exact-amount allowance for Circle's TokenMessenger. Never unlimited.",
          request: {
            namespace: "evm",
            chainId,
            numericChainId: source.numericChainId,
            to: source.usdcAddress,
            // Exact amount, so a stale allowance cannot be reused later.
            data: encodeApprove(source.tokenMessengerV2, amount),
            value: "0",
          },
        },
        {
          id: "cctp-burn",
          kind: "funding",
          chainId,
          label: "Send USDC to Solana",
          description: "Burns USDC and asks Circle's Forwarding Service to deliver it on Solana.",
          request: {
            namespace: "evm",
            chainId,
            numericChainId: source.numericChainId,
            to: source.tokenMessengerV2,
            data: encodeDepositForBurnWithHook({
              amount,
              destinationDomain: solana.cctpDomain,
              mintRecipient: mintRecipient as `0x${string}`,
              burnToken: source.usdcAddress,
              destinationCaller: ZERO_BYTES32,
              maxFee: BigInt(maxFee),
              minFinalityThreshold: finalityThreshold as number,
              hookData: hookData as `0x${string}`,
            }),
            value: "0",
          },
        },
      ];
    },

    getStatus: async ({ intent, quote, reference }, context): Promise<FundingStatus> => {
      const { data, source } = requirePins(intent, quote);
      if (reference.chainId !== `eip155:${source.numericChainId}`) {
        fail("REFERENCE_CHAIN_MISMATCH", "The CCTP source reference must be on the source chain.");
      }
      if (!TX_HASH.test(reference.txId)) {
        fail("INVALID_REFERENCE", "The CCTP source reference must be a 32-byte transaction hash.");
      }
      const checkedAt = new Date(context.now()).toISOString();
      const base: Omit<FundingStatus, "state" | "detail"> = {
        reference,
        // Circle's message API exposes no destination transaction identifier,
        // so there is nothing honest to put here. Delivery is proven below by
        // reading the destination account instead.
        destinationReference: null,
        received: null,
        checkedAt,
      };

      const response = await fetchImpl(
        `${apiBaseUrl}/v2/messages/${source.cctpDomain}?transactionHash=${encodeURIComponent(reference.txId)}`,
        { headers: { accept: "application/json" }, ...(context.signal ? { signal: context.signal } : {}) },
      );
      if (response.status === 404) {
        return { ...base, state: "pending", detail: "Circle has not indexed this burn yet." };
      }
      if (!response.ok) {
        fail("STATUS_SERVICE_UNAVAILABLE", `Circle's status service returned ${response.status}.`);
      }
      const payload: unknown = await response.json();
      const messages = isRecord(payload) && Array.isArray(payload.messages) ? payload.messages : [];
      const message = messages.find(isRecord);
      const attestation = message?.attestation;
      const attested =
        message?.status === "complete" ||
        (typeof attestation === "string" && attestation !== "PENDING" && attestation.startsWith("0x"));

      if (!attested) {
        return { ...base, state: "pending", detail: "Circle is attesting the burn." };
      }

      // Attestation means the message is signed, NOT that USDC reached the
      // user. Prove delivery by reading the destination account instead.
      const account = data.destinationTokenAccount;
      const baselineRaw = data.baselineBaseUnits;
      const minimumRaw = data.minimumOutput;
      if (typeof account !== "string" || typeof baselineRaw !== "string" || typeof minimumRaw !== "string") {
        fail("INVALID_QUOTE_DATA", "The CCTP quote is missing its delivery baseline.");
      }
      const balance = await tokenAccountBalance(account, context.signal);
      if (balance === null || balance - BigInt(baselineRaw) < BigInt(minimumRaw)) {
        return {
          ...base,
          state: "pending",
          detail: "Circle attested the burn; the Forwarding Service has not delivered yet.",
        };
      }
      return {
        ...base,
        state: "completed",
        detail: "USDC delivered to the destination token account on Solana.",
      };
    },
  });
}

export type { TransactionReference };
