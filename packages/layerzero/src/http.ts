import { RailPluginError, type JsonValue } from "@hedgents/stablecoin-rail";
import type {
  LayerZeroQuote,
  LayerZeroStatus,
  LayerZeroTransferApiOptions,
  LayerZeroUserStep,
} from "./types.js";

const PLUGIN_ID = "layerzero-usdt0-tron-solana";
const DEFAULT_BASE_URL = "https://transfer.layerzero-api.com/v1";

export class LayerZeroTransferApi {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: LayerZeroTransferApiOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new RailPluginError(PLUGIN_ID, "MISSING_API_KEY", "A LayerZero API key is required.");
    }
    const tolerance = options.feeTolerancePercent ?? 1;
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 10) {
      throw new RailPluginError(
        PLUGIN_ID,
        "INVALID_FEE_TOLERANCE",
        "LayerZero fee tolerance must be between 0 and 10 percent.",
      );
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.feeTolerancePercent = tolerance;
  }

  readonly feeTolerancePercent: number;

  async quote(
    request: {
      amount: string;
      srcWalletAddress: string;
      dstWalletAddress: string;
      srcTokenAddress: string;
      dstTokenAddress: string;
    },
    signal?: AbortSignal,
  ): Promise<LayerZeroQuote[]> {
    const response = await this.request<{ quotes?: LayerZeroQuote[] }>(
      "/quotes",
      {
        method: "POST",
        body: {
          amount: request.amount,
          srcChainKey: "tron",
          srcTokenAddress: request.srcTokenAddress,
          srcWalletAddress: request.srcWalletAddress,
          dstChainKey: "solana",
          dstTokenAddress: request.dstTokenAddress,
          dstWalletAddress: request.dstWalletAddress,
          options: {
            amountType: "EXACT_SRC_AMOUNT",
            feeTolerance: {
              type: "PERCENT",
              amount: this.feeTolerancePercent,
            },
            dstNativeDropAmount: "0",
          },
        },
      },
      signal,
    );
    return Array.isArray(response.quotes) ? response.quotes : [];
  }

  async buildUserSteps(quoteId: string, signal?: AbortSignal): Promise<LayerZeroUserStep[]> {
    const response = await this.request<{ userSteps?: LayerZeroUserStep[] }>(
      "/build-user-steps",
      { method: "POST", body: { quoteId } },
      signal,
    );
    return Array.isArray(response.userSteps) ? response.userSteps : [];
  }

  status(quoteId: string, txHash: string, signal?: AbortSignal): Promise<LayerZeroStatus> {
    return this.request<LayerZeroStatus>(
      `/status/${encodeURIComponent(quoteId)}?txHash=${encodeURIComponent(txHash)}`,
      { method: "GET" },
      signal,
    );
  }

  private async request<T>(
    path: string,
    request: { method: "GET" | "POST"; body?: JsonValue },
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: request.method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      throw new RailPluginError(
        PLUGIN_ID,
        "UPSTREAM_UNREACHABLE",
        "The LayerZero transfer API could not be reached.",
        { cause },
      );
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 1_000);
      throw new RailPluginError(
        PLUGIN_ID,
        "UPSTREAM_REJECTED",
        detail || `LayerZero returned HTTP ${response.status}.`,
      );
    }
    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new RailPluginError(
        PLUGIN_ID,
        "INVALID_UPSTREAM_RESPONSE",
        "LayerZero returned malformed JSON.",
        { cause },
      );
    }
  }
}
