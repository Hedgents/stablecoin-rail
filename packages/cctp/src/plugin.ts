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
import {
  decodeBase58,
  deriveAssociatedTokenAddress,
  toBytes32,
} from "@hedgents/stablecoin-rail-solana";
import { assertChecksumAddress, encodeApprove, encodeDepositForBurnWithHook } from "./abi.js";
import { protocolFee, selectFeeTier } from "./fees.js";
import { buildSolanaForwardHook } from "./hook.js";
import type { CctpOptions, CctpSourceChain } from "./types.js";

const PLUGIN_ID = "circle-cctp-v2-solana";
const OPAQUE_SCHEMA = "hedgents.cctp.v2.evm-solana.v1";
const DEFAULT_API = "https://iris-api.circle.com";
const DEFAULT_FINALITY = 1000;
const DEFAULT_TTL_SECONDS = 90;
/** Circle's CCTP V2 programs on Solana, identical on mainnet and devnet. */
const SOLANA_MESSAGE_TRANSMITTER_V2 = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";
const SOLANA_TOKEN_MESSENGER_MINTER_V2 = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";
const DEFAULT_DELIVERY_SCAN_LIMIT = 20;
const NEGATIVE_CACHE_LIMIT = 500;
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

/**
 * Solana answers `getTokenAccountBalance` for a missing account with JSON-RPC
 * error -32602 rather than a null result. ONLY that specific error may be read
 * as "no account yet": transient node errors (rate limits, node-behind,
 * storage faults) arrive over HTTP 200 in the same envelope, and mistaking one
 * for a missing account would zero the recorded pre-delivery baseline and mark
 * a funded account as needing recipient setup.
 */
function isMissingAccountError(error: unknown): boolean {
  return (
    isRecord(error) &&
    error.code === -32602 &&
    typeof error.message === "string" &&
    /could not find account/i.test(error.message)
  );
}

/** jsonParsed account keys arrive as strings or as `{ pubkey }` records. */
function accountKeysOf(transaction: unknown): string[] {
  if (!isRecord(transaction) || !isRecord(transaction.message)) return [];
  const keys = transaction.message.accountKeys;
  if (!Array.isArray(keys)) return [];
  return keys.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (isRecord(entry) && typeof entry.pubkey === "string") return [entry.pubkey];
    return [];
  });
}

interface TokenBalanceEntry {
  owner?: unknown;
  mint?: unknown;
  uiTokenAmount?: { amount?: unknown };
}

/** The owner's total balance change for one mint across a transaction. */
function ownerMintDelta(meta: Record<string, unknown>, owner: string, mint: string): bigint {
  const entries = (value: unknown): TokenBalanceEntry[] =>
    Array.isArray(value) ? (value as TokenBalanceEntry[]) : [];
  const amountOf = (entry: TokenBalanceEntry): bigint => {
    const raw = entry.uiTokenAmount?.amount;
    return typeof raw === "string" && INTEGER.test(raw) ? BigInt(raw) : 0n;
  };
  const matches = (entry: TokenBalanceEntry) => entry.owner === owner && entry.mint === mint;
  const post = entries(meta.postTokenBalances).filter(matches).reduce((sum, entry) => sum + amountOf(entry), 0n);
  const pre = entries(meta.preTokenBalances).filter(matches).reduce((sum, entry) => sum + amountOf(entry), 0n);
  return post - pre;
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
  const deliveryPrograms = new Set(
    solana.deliveryProgramIds ?? [SOLANA_MESSAGE_TRANSMITTER_V2, SOLANA_TOKEN_MESSENGER_MINTER_V2],
  );
  for (const program of deliveryPrograms) {
    if (!SOLANA_ADDRESS.test(program)) {
      throw new RailPluginError(PLUGIN_ID, "INVALID_PROGRAM_ID", "A delivery program ID is not a base58 address.");
    }
  }
  const scanLimit = options.deliveryScanLimit ?? DEFAULT_DELIVERY_SCAN_LIMIT;
  /** Signatures proven not to be this route's delivery; skipped on later polls. */
  const notDelivery = new Set<string>();

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

  async function rpcCall(
    method: string,
    params: unknown[],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await fetchImpl(options.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "rail-cctp", method, params }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) fail("RPC_UNAVAILABLE", `The Solana RPC returned ${response.status}.`);
    const payload: unknown = await response.json();
    if (!isRecord(payload)) fail("RPC_UNAVAILABLE", "The Solana RPC returned a malformed response.");
    return payload;
  }

  /**
   * Current balance of a token account, or `null` only when the account
   * provably does not exist. Any other JSON-RPC error fails closed as
   * RPC_UNAVAILABLE: an ambiguous read must abort the quote, never masquerade
   * as an empty account, because this figure seeds the recipient-setup
   * decision.
   */
  async function tokenAccountBalance(account: string, signal?: AbortSignal): Promise<bigint | null> {
    const payload = await rpcCall("getTokenAccountBalance", [account, { commitment: "confirmed" }], signal);
    if (payload.error) {
      if (isMissingAccountError(payload.error)) return null;
      const message = isRecord(payload.error) && typeof payload.error.message === "string"
        ? payload.error.message
        : "an unspecified error";
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

  interface DeliveryCredit {
    signature: string;
    receivedBaseUnits: bigint;
    submittedAt: string | null;
  }

  type ExactDeliveryResult =
    | { state: "pending" }
    | { state: "failed"; detail: string }
    | { state: "completed"; delivery: DeliveryCredit };

  function isSolanaSignature(value: unknown): value is string {
    if (typeof value !== "string") return false;
    try {
      return decodeBase58(value).length === 64;
    } catch {
      return false;
    }
  }

  /**
   * Verify the exact Forwarding Service transaction returned by Circle.
   *
   * `forwardTxHash` binds the source burn to one destination transaction, so
   * it is strictly stronger than searching recent recipient activity. The
   * transaction still has to succeed, invoke a configured CCTP program, and
   * credit this quote's owner and mint by at least the guaranteed minimum.
   */
  async function verifyExactDeliveryTransaction(
    signature: string,
    owner: string,
    minimum: bigint,
    signal?: AbortSignal,
  ): Promise<ExactDeliveryResult> {
    const tx = await rpcCall(
      "getTransaction",
      [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
      signal,
    );
    if (tx.error) fail("RPC_UNAVAILABLE", "The Solana RPC failed the forwarded-transaction read.");
    const result = tx.result;
    if (!isRecord(result)) return { state: "pending" };
    const meta = result.meta;
    if (!isRecord(meta)) {
      return { state: "failed", detail: "Circle's forwarded transaction has no readable metadata." };
    }
    if (meta.err) {
      return { state: "failed", detail: "Circle's forwarded transaction failed on Solana." };
    }
    if (!accountKeysOf(result.transaction).some((key) => deliveryPrograms.has(key))) {
      return {
        state: "failed",
        detail: "Circle's forwarded transaction does not invoke a configured CCTP program.",
      };
    }
    const delta = ownerMintDelta(meta, owner, solana.usdcMint);
    if (delta < minimum) {
      return {
        state: "failed",
        detail: "Circle's forwarded transaction credited less USDC than the guaranteed minimum.",
      };
    }
    const blockTime = result.blockTime;
    return {
      state: "completed",
      delivery: {
        signature,
        receivedBaseUnits: delta,
        submittedAt:
          typeof blockTime === "number" && Number.isFinite(blockTime)
            ? new Date(blockTime * 1_000).toISOString()
            : null,
      },
    };
  }

  /**
   * The transaction that actually delivered this transfer, or `null` while
   * none exists yet.
   *
   * A raw balance-versus-baseline comparison cannot attribute a credit: an
   * unrelated inbound payment satisfies it, and an unrelated spend starves it
   * forever. The scan instead walks the recipient token account's recent
   * transactions for one that succeeded, involves Circle's CCTP programs, and
   * credits the recipient wallet by at least the guaranteed minimum. That
   * transaction is returned as delivery evidence, with the measured credit.
   */
  async function findDeliveryTransaction(
    account: string,
    owner: string,
    minimum: bigint,
    signal?: AbortSignal,
  ): Promise<DeliveryCredit | null> {
    const payload = await rpcCall(
      "getSignaturesForAddress",
      [account, { limit: scanLimit, commitment: "confirmed" }],
      signal,
    );
    if (payload.error) {
      fail("RPC_UNAVAILABLE", "The Solana RPC failed the delivery scan.");
    }
    const entries = Array.isArray(payload.result) ? payload.result : [];
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.signature !== "string") continue;
      if (entry.err != null) continue;
      if (notDelivery.has(entry.signature)) continue;

      const tx = await rpcCall(
        "getTransaction",
        [entry.signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
        signal,
      );
      // An RPC error here must surface, not read as "not indexed yet": a
      // persistently erroring node would otherwise pend the flow forever
      // with no signal to the host.
      if (tx.error) fail("RPC_UNAVAILABLE", "The Solana RPC failed the delivery-transaction read.");
      const result = tx.result;
      // Not indexed at this commitment yet: leave uncached and retry next poll.
      if (!isRecord(result)) continue;
      const meta = result.meta;
      if (!isRecord(meta) || meta.err) {
        rememberNotDelivery(entry.signature);
        continue;
      }
      if (!accountKeysOf(result.transaction).some((key) => deliveryPrograms.has(key))) {
        rememberNotDelivery(entry.signature);
        continue;
      }
      const delta = ownerMintDelta(meta, owner, solana.usdcMint);
      if (delta >= minimum) {
        const blockTime = result.blockTime;
        return {
          signature: entry.signature,
          receivedBaseUnits: delta,
          submittedAt:
            typeof blockTime === "number" && Number.isFinite(blockTime)
              ? new Date(blockTime * 1_000).toISOString()
              : null,
        };
      }
      // A CCTP transaction below this quote's minimum is some other transfer's
      // delivery. NOT cached: the cache is shared across quotes, and the same
      // transaction may satisfy a concurrent quote with a smaller minimum.
    }
    return null;
  }

  function rememberNotDelivery(signature: string) {
    if (notDelivery.size >= NEGATIVE_CACHE_LIMIT) {
      const oldest = notDelivery.values().next().value;
      if (oldest) notDelivery.delete(oldest);
    }
    notDelivery.add(signature);
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
      version: "0.1.3",
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
        // Filled only after the destination transaction has been read and its
        // exact owner, mint, program, and credit have been verified.
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

      // The message was looked up by this quote's source transaction, so its
      // decoded fields must describe this quote's transfer. A mismatch means
      // the referenced burn is some other transfer, which is affirmative
      // disproof rather than a transient condition.
      if (!attestedMessageMatchesQuote(message, intent.inputAmountBaseUnits, data)) {
        return {
          ...base,
          state: "failed",
          detail: "The attested burn does not match this quote's destination, amount, or recipient.",
        };
      }

      // Attestation means the message is signed, NOT that USDC reached the
      // user. Prove delivery by finding the CCTP transaction that credited
      // the recipient, so an unrelated deposit cannot complete this flow and
      // an unrelated spend cannot starve it.
      const account = data.destinationTokenAccount;
      const minimumRaw = data.minimumOutput;
      if (typeof account !== "string" || typeof minimumRaw !== "string") {
        fail("INVALID_QUOTE_DATA", "The CCTP quote is missing its delivery data.");
      }

      const forwardTxHash = message?.forwardTxHash;
      let delivery: DeliveryCredit | null = null;
      if (forwardTxHash != null) {
        if (!isSolanaSignature(forwardTxHash)) {
          fail("INVALID_FORWARD_TX_HASH", "Circle returned an invalid Solana forwarding transaction signature.");
        }
        const exact = await verifyExactDeliveryTransaction(
          forwardTxHash,
          intent.destination.account.address,
          BigInt(minimumRaw),
          context.signal,
        );
        if (exact.state === "failed") {
          return { ...base, state: "failed", detail: exact.detail };
        }
        if (exact.state === "completed") delivery = exact.delivery;
      } else {
        // Compatibility path for recorded or older Iris responses that omit
        // forwardTxHash. Current CCTP V2 responses identify the exact Solana
        // transaction, which always takes precedence over this bounded scan.
        delivery = await findDeliveryTransaction(
          account,
          intent.destination.account.address,
          BigInt(minimumRaw),
          context.signal,
        );
      }
      if (!delivery) {
        return {
          ...base,
          state: "pending",
          detail: "Circle attested the burn; the Forwarding Service has not delivered yet.",
        };
      }
      return {
        ...base,
        destinationReference: {
          chainId: solana.chainId,
          txId: delivery.signature,
          submittedAt: delivery.submittedAt ?? checkedAt,
        },
        received: {
          asset: intent.destination.settlementAsset,
          amountBaseUnits: delivery.receivedBaseUnits.toString(),
        },
        state: "completed",
        detail: "USDC delivered to the destination token account on Solana.",
      };
    },
  });

  /**
   * True when the attested message's decoded fields agree with the quote's
   * pins. Fields Circle omits are skipped rather than failed, so an API shape
   * change degrades to the delivery scan instead of wedging every flow.
   */
  function attestedMessageMatchesQuote(
    message: Record<string, unknown> | undefined,
    sourceAmount: string,
    data: Record<string, unknown>,
  ): boolean {
    const decoded = message && isRecord(message.decodedMessage) ? message.decodedMessage : null;
    if (!decoded) return true;
    if (decoded.destinationDomain != null && String(decoded.destinationDomain) !== String(solana.cctpDomain)) {
      return false;
    }
    const body = isRecord(decoded.decodedMessageBody) ? decoded.decodedMessageBody : null;
    if (!body) return true;
    // Compare the amount only when it arrives in the decimal-string shape
    // Circle documents today. An unrecognized rendering skips the check and
    // falls through to the delivery scan, rather than affirmatively failing a
    // healthy transfer over an API formatting change.
    const bodyAmount =
      typeof body.amount === "number" && Number.isSafeInteger(body.amount)
        ? String(body.amount)
        : body.amount;
    if (typeof bodyAmount === "string" && INTEGER.test(bodyAmount) && bodyAmount !== sourceAmount) {
      return false;
    }
    return mintRecipientMatches(body.mintRecipient, data.mintRecipient);
  }

  function mintRecipientMatches(reported: unknown, pinned: unknown): boolean {
    if (typeof reported !== "string" || typeof pinned !== "string") return true;
    const normalize = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
    if (/^0x[0-9a-fA-F]+$/.test(reported)) return normalize(reported) === normalize(pinned);
    // Circle may render a Solana recipient in base58 rather than hex.
    if (SOLANA_ADDRESS.test(reported)) return normalize(toBytes32(reported)) === normalize(pinned);
    return true;
  }
}

export type { TransactionReference };
