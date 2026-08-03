import { RailError } from "./errors.js";
import type {
  AssetAmount,
  AssetDescriptor,
  DestinationActionStatus,
  DestinationActionQuoteDraft,
  FundingIntent,
  FundingQuoteDraft,
  FundingStatus,
  PluginManifest,
  TransactionReference,
  WalletStep,
} from "./types.js";

const INTEGER = /^\d+$/;
const TRON_BASE58 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

function requireText(value: string, field: string) {
  if (value.trim().length === 0) throw new RailError("INVALID_INPUT", `${field} is required.`);
}

export function parseAmount(value: string, field = "amount") {
  if (!INTEGER.test(value)) {
    throw new RailError("INVALID_AMOUNT", `${field} must be an unsigned base-unit integer.`);
  }
  const amount = BigInt(value);
  if (amount <= 0n) throw new RailError("INVALID_AMOUNT", `${field} must be greater than zero.`);
  return amount;
}

export function validateAsset(asset: AssetDescriptor, field: string) {
  requireText(asset.chainId, `${field}.chainId`);
  requireText(asset.assetId, `${field}.assetId`);
  requireText(asset.symbol, `${field}.symbol`);
  if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255) {
    throw new RailError("INVALID_ASSET", `${field}.decimals must be an integer from 0 to 255.`);
  }
}

export function sameAsset(left: AssetDescriptor, right: AssetDescriptor) {
  return (
    left.chainId === right.chainId &&
    left.assetId === right.assetId &&
    left.decimals === right.decimals
  );
}

export function validateAssetAmount(amount: AssetAmount, field: string) {
  validateAsset(amount.asset, `${field}.asset`);
  parseAmount(amount.amountBaseUnits, `${field}.amountBaseUnits`);
}

export function validateIntent(intent: FundingIntent) {
  requireText(intent.id, "intent.id");
  requireText(intent.source.account.address, "intent.source.account.address");
  requireText(intent.destination.account.address, "intent.destination.account.address");
  if (intent.action) requireText(intent.action.pluginId, "intent.action.pluginId");
  validateAsset(intent.source.asset, "intent.source.asset");
  validateAsset(intent.destination.settlementAsset, "intent.destination.settlementAsset");
  if (intent.source.account.chainId !== intent.source.asset.chainId) {
    throw new RailError("CHAIN_MISMATCH", "The source account and source asset use different chains.");
  }
  if (intent.destination.account.chainId !== intent.destination.settlementAsset.chainId) {
    throw new RailError(
      "CHAIN_MISMATCH",
      "The destination account and settlement asset use different chains.",
    );
  }
  parseAmount(intent.inputAmountBaseUnits, "intent.inputAmountBaseUnits");
  if (!Number.isInteger(intent.slippageBps) || intent.slippageBps < 0 || intent.slippageBps > 10_000) {
    throw new RailError("INVALID_SLIPPAGE", "intent.slippageBps must be between 0 and 10,000.");
  }
}

export function validateManifest(manifest: PluginManifest, expectedKind: PluginManifest["kind"]) {
  requireText(manifest.id, "plugin.manifest.id");
  requireText(manifest.name, "plugin.manifest.name");
  requireText(manifest.version, "plugin.manifest.version");
  if (manifest.apiVersion !== 1) {
    throw new RailError("UNSUPPORTED_PLUGIN_API", `Plugin ${manifest.id} does not use API version 1.`);
  }
  if (manifest.kind !== expectedKind) {
    throw new RailError("INVALID_PLUGIN_KIND", `Plugin ${manifest.id} has the wrong plugin kind.`);
  }
}

function validateExpiry(expiresAt: string, now: number, field: string) {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) throw new RailError("INVALID_QUOTE", `${field} is not a valid date.`);
  if (expiry <= now) throw new RailError("QUOTE_EXPIRED", `${field} has already expired.`);
  return expiry;
}

export function validateFundingQuote(
  quote: FundingQuoteDraft,
  intent: FundingIntent,
  now: number,
) {
  requireText(quote.id, "fundingQuote.id");
  validateAssetAmount(quote.input, "fundingQuote.input");
  validateAssetAmount(quote.expectedOutput, "fundingQuote.expectedOutput");
  validateAssetAmount(quote.minimumOutput, "fundingQuote.minimumOutput");
  if (!sameAsset(quote.input.asset, intent.source.asset)) {
    throw new RailError("QUOTE_ASSET_MISMATCH", "The funding quote changed the source asset.");
  }
  if (quote.input.amountBaseUnits !== intent.inputAmountBaseUnits) {
    throw new RailError("QUOTE_AMOUNT_MISMATCH", "The funding quote changed the exact input amount.");
  }
  if (!sameAsset(quote.expectedOutput.asset, intent.destination.settlementAsset)) {
    throw new RailError("QUOTE_ASSET_MISMATCH", "The funding quote returned another settlement asset.");
  }
  if (!sameAsset(quote.expectedOutput.asset, quote.minimumOutput.asset)) {
    throw new RailError("QUOTE_ASSET_MISMATCH", "Funding expected and minimum outputs differ by asset.");
  }
  if (parseAmount(quote.minimumOutput.amountBaseUnits) > parseAmount(quote.expectedOutput.amountBaseUnits)) {
    throw new RailError("INVALID_QUOTE", "Funding minimum output exceeds expected output.");
  }
  if (!Number.isFinite(quote.etaSeconds) || quote.etaSeconds < 0) {
    throw new RailError("INVALID_QUOTE", "Funding ETA must be a non-negative number.");
  }
  if (quote.executionMode !== "two-phase") {
    throw new RailError("UNSUPPORTED_EXECUTION_MODE", "Version 0.1 only supports two-phase execution.");
  }
  validateExpiry(quote.expiresAt, now, "fundingQuote.expiresAt");
  for (const [index, fee] of quote.fees.entries()) {
    requireText(fee.label, `fundingQuote.fees[${index}].label`);
    validateAssetAmount(fee.amount, `fundingQuote.fees[${index}].amount`);
  }
}

export function validateActionQuote(
  quote: DestinationActionQuoteDraft,
  funding: FundingQuoteDraft,
  now: number,
) {
  requireText(quote.id, "actionQuote.id");
  validateAssetAmount(quote.input, "actionQuote.input");
  validateAssetAmount(quote.expectedOutput, "actionQuote.expectedOutput");
  validateAssetAmount(quote.minimumOutput, "actionQuote.minimumOutput");
  if (!sameAsset(quote.input.asset, funding.minimumOutput.asset)) {
    throw new RailError("QUOTE_ASSET_MISMATCH", "The action does not consume the settlement asset.");
  }
  if (quote.input.amountBaseUnits !== funding.minimumOutput.amountBaseUnits) {
    throw new RailError(
      "QUOTE_AMOUNT_MISMATCH",
      "The action must be quoted from the funding route's guaranteed minimum output.",
    );
  }
  if (!sameAsset(quote.expectedOutput.asset, quote.minimumOutput.asset)) {
    throw new RailError("QUOTE_ASSET_MISMATCH", "Action expected and minimum outputs differ by asset.");
  }
  if (parseAmount(quote.minimumOutput.amountBaseUnits) > parseAmount(quote.expectedOutput.amountBaseUnits)) {
    throw new RailError("INVALID_QUOTE", "Action minimum output exceeds expected output.");
  }
  validateExpiry(quote.expiresAt, now, "actionQuote.expiresAt");
  for (const [index, fee] of quote.fees.entries()) {
    requireText(fee.label, `actionQuote.fees[${index}].label`);
    validateAssetAmount(fee.amount, `actionQuote.fees[${index}].amount`);
  }
}

export function validateWalletSteps(steps: WalletStep[]) {
  if (steps.length === 0) throw new RailError("EMPTY_WALLET_STEPS", "The plugin returned no wallet steps.");
  const ids = new Set<string>();
  for (const step of steps) {
    requireText(step.id, "walletStep.id");
    requireText(step.label, "walletStep.label");
    requireText(step.chainId, "walletStep.chainId");
    if (ids.has(step.id)) throw new RailError("DUPLICATE_STEP", `Wallet step ${step.id} is duplicated.`);
    ids.add(step.id);
    if (step.chainId !== step.request.chainId) {
      throw new RailError("CHAIN_MISMATCH", `Wallet step ${step.id} has inconsistent chain IDs.`);
    }
    if (step.request.namespace === "evm") {
      if (!Number.isSafeInteger(step.request.numericChainId) || step.request.numericChainId <= 0) {
        throw new RailError("INVALID_WALLET_STEP", `Wallet step ${step.id} has an invalid EVM chain ID.`);
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(step.request.to)) {
        throw new RailError("INVALID_WALLET_STEP", `Wallet step ${step.id} has an invalid EVM target.`);
      }
      if (!/^0x[0-9a-fA-F]*$/.test(step.request.data) || !INTEGER.test(step.request.value)) {
        throw new RailError("INVALID_WALLET_STEP", `Wallet step ${step.id} has malformed EVM data.`);
      }
      if (step.request.chainId !== `eip155:${step.request.numericChainId}`) {
        throw new RailError("CHAIN_MISMATCH", `Wallet step ${step.id} has inconsistent EVM chain IDs.`);
      }
    } else if (step.request.namespace === "solana") {
      if (!step.request.chainId.startsWith("solana:")) {
        throw new RailError("CHAIN_MISMATCH", `Wallet step ${step.id} is not on a Solana chain.`);
      }
      if (
        step.request.transactionBase64.length === 0 ||
        step.request.transactionBase64.length > 20_000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(step.request.transactionBase64)
      ) {
        throw new RailError("INVALID_WALLET_STEP", `Wallet step ${step.id} has no valid Solana transaction.`);
      }
    } else {
      if (!step.request.chainId.startsWith("tron:")) {
        throw new RailError("CHAIN_MISMATCH", `Wallet step ${step.id} is not on a TRON chain.`);
      }
      if (!TRON_BASE58.test(step.request.signerAddress)) {
        throw new RailError("INVALID_WALLET_STEP", `Wallet step ${step.id} has an invalid TRON signer.`);
      }
      const keys = Object.keys(step.request.transaction);
      if (keys.length === 0) {
        throw new RailError("INVALID_WALLET_STEP", `Wallet step ${step.id} has no TRON transaction.`);
      }
      let encoded: string;
      try {
        encoded = JSON.stringify(step.request.transaction);
      } catch {
        throw new RailError("INVALID_WALLET_STEP", `Wallet step ${step.id} has a malformed TRON transaction.`);
      }
      if (encoded.length > 100_000) {
        throw new RailError("INVALID_WALLET_STEP", `Wallet step ${step.id} has an oversized TRON transaction.`);
      }
    }
  }
}

export function validateReference(reference: TransactionReference) {
  requireText(reference.chainId, "reference.chainId");
  requireText(reference.txId, "reference.txId");
  if (!Number.isFinite(Date.parse(reference.submittedAt))) {
    throw new RailError("INVALID_REFERENCE", "reference.submittedAt must be a valid date.");
  }
}

export function assertQuoteFresh(expiresAt: string, now: number) {
  if (Date.parse(expiresAt) <= now) {
    throw new RailError("QUOTE_EXPIRED", "The selected end-to-end quote has expired. Request a new quote.");
  }
}

function sameReference(left: TransactionReference, right: TransactionReference) {
  return left.chainId === right.chainId && left.txId === right.txId;
}

function validateCheckedAt(value: string) {
  if (!Number.isFinite(Date.parse(value))) {
    throw new RailError("INVALID_STATUS", "The plugin returned an invalid checkedAt timestamp.");
  }
}

export function validateFundingStatus(
  status: FundingStatus,
  reference: TransactionReference,
  destinationAsset: AssetDescriptor,
) {
  validateReference(status.reference);
  if (!sameReference(status.reference, reference)) {
    throw new RailError("STATUS_REFERENCE_MISMATCH", "Funding status refers to another transaction.");
  }
  validateCheckedAt(status.checkedAt);
  if (status.destinationReference) validateReference(status.destinationReference);
  if (status.received) {
    validateAssetAmount(status.received, "fundingStatus.received");
    if (!sameAsset(status.received.asset, destinationAsset)) {
      throw new RailError("STATUS_ASSET_MISMATCH", "Funding status returned another destination asset.");
    }
  }
}

export function validateActionStatus(
  status: DestinationActionStatus,
  reference: TransactionReference,
  outputAsset: AssetDescriptor,
) {
  validateReference(status.reference);
  if (!sameReference(status.reference, reference)) {
    throw new RailError("STATUS_REFERENCE_MISMATCH", "Action status refers to another transaction.");
  }
  validateCheckedAt(status.checkedAt);
  if (status.received) {
    validateAssetAmount(status.received, "actionStatus.received");
    if (!sameAsset(status.received.asset, outputAsset)) {
      throw new RailError("STATUS_ASSET_MISMATCH", "Action status returned another output asset.");
    }
  }
}
