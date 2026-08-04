import type { AssetAmount, PluginContext, SettlementVerifier } from "@hedgents/stablecoin-rail";
import { SPL_TOKEN_PROGRAM_ID } from "./addresses.js";

export interface SolanaSettlementVerifierOptions {
  rpcUrl: string;
  commitment?: "confirmed" | "finalized";
  /** Expected owning token program. Pass TOKEN_2022_PROGRAM_ID for a Token-2022 mint. */
  tokenProgram?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

interface TokenBalance {
  accountIndex?: unknown;
  mint?: unknown;
  owner?: unknown;
  programId?: unknown;
  uiTokenAmount?: { amount?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "solana:mainnet/spl:EPjF..." becomes "EPjF...". */
function mintFromAssetId(assetId: string): string {
  const separator = assetId.lastIndexOf(":");
  return separator === -1 ? assetId : assetId.slice(separator + 1);
}

function balances(value: unknown): TokenBalance[] {
  return Array.isArray(value) ? (value as TokenBalance[]) : [];
}

function amountOf(entry: TokenBalance | undefined): bigint {
  const raw = entry?.uiTokenAmount?.amount;
  return typeof raw === "string" && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
}

/**
 * Confirms how much of the settlement asset actually reached the destination
 * wallet, by reading the token-account balance delta of the delivery
 * transaction.
 *
 * Every unverifiable condition returns `null` rather than throwing, so an RPC
 * hiccup or an indexing lag degrades to the rail's quoted-minimum fallback
 * instead of breaking a flow whose funds have already moved. The decision to
 * reject a short delivery belongs to the core, which compares this amount
 * against the guaranteed minimum.
 */
export function createSolanaSettlementVerifier(
  options: SolanaSettlementVerifierOptions,
): SettlementVerifier {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const commitment = options.commitment ?? "confirmed";
  const expectedProgram = options.tokenProgram ?? SPL_TOKEN_PROGRAM_ID;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async verify({ intent, status }, context: PluginContext): Promise<AssetAmount | null> {
      const reference = status.destinationReference;
      if (!reference || !reference.chainId.startsWith("solana:")) return null;

      const settlementAsset = intent.destination.settlementAsset;
      const mint = mintFromAssetId(settlementAsset.assetId);
      const owner = intent.destination.account.address;

      let payload: unknown;
      try {
        const response = await fetchImpl(options.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "rail-settlement",
            method: "getTransaction",
            params: [
              reference.txId,
              { encoding: "jsonParsed", commitment, maxSupportedTransactionVersion: 0 },
            ],
          }),
          signal: context.signal ?? AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return null;
        payload = await response.json();
      } catch {
        return null;
      }

      if (!isRecord(payload) || !isRecord(payload.result)) return null;
      const meta = payload.result.meta;
      if (!isRecord(meta) || meta.err) return null;

      // A delivery may legitimately touch more than one token account of the
      // same owner and mint (an ATA plus an auxiliary account). Measuring only
      // the first match would make the verified amount depend on account
      // ordering inside the transaction, which the relayer controls, so the
      // owner's TOTAL delta across every matching account is measured instead.
      // A mint served by an unexpected token program is not the asset we
      // quoted, and its entries are excluded from both sides of the delta.
      const matches = (entry: TokenBalance) =>
        entry.owner === owner &&
        entry.mint === mint &&
        (typeof entry.programId !== "string" || entry.programId === expectedProgram);
      const postMatches = balances(meta.postTokenBalances).filter(matches);
      const preMatches = balances(meta.preTokenBalances).filter(matches);
      if (postMatches.length === 0 && preMatches.length === 0) return null;

      const postTotal = postMatches.reduce((sum, entry) => sum + amountOf(entry), 0n);
      const preTotal = preMatches.reduce((sum, entry) => sum + amountOf(entry), 0n);
      const delta = postTotal - preTotal;
      if (delta <= 0n) return null;

      return { asset: settlementAsset, amountBaseUnits: delta.toString() };
    },
  };
}
