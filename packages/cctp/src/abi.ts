import { keccak_256 } from "@noble/hashes/sha3";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x([0-9a-fA-F]{2})*$/;

/** First four bytes of the keccak-256 hash of a Solidity function signature. */
export function selector(signature: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(signature)).slice(0, 4);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function byteLength(value: string, field: string): number {
  if (!HEX.test(value)) throw new Error(`${field} must be 0x-prefixed hex of whole bytes.`);
  return (value.length - 2) / 2;
}

function word(value: bigint, field: string): string {
  if (value < 0n || value >= 2n ** 256n) throw new Error(`${field} does not fit in a uint256.`);
  return value.toString(16).padStart(64, "0");
}

function addressWord(value: string, field: string): string {
  if (!ADDRESS.test(value)) throw new Error(`${field} must be a 20-byte hex address.`);
  return value.slice(2).toLowerCase().padStart(64, "0");
}

function bytes32Word(value: string, field: string): string {
  if (!BYTES32.test(value)) throw new Error(`${field} must be exactly thirty-two bytes.`);
  return value.slice(2).toLowerCase();
}

export function encodeApprove(spender: string, amount: bigint): `0x${string}` {
  return `0x${toHex(selector("approve(address,uint256)"))}${addressWord(spender, "spender")}${word(amount, "amount")}`;
}

export interface DepositForBurnArgs {
  amount: bigint;
  destinationDomain: number;
  mintRecipient: `0x${string}`;
  burnToken: string;
  destinationCaller: `0x${string}`;
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData: `0x${string}`;
}

const DEPOSIT_FOR_BURN_WITH_HOOK =
  "depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)";

/** Eight static head words precede the dynamic `bytes hookData` tail. */
const HEAD_WORDS = 8n;

export function encodeDepositForBurnWithHook(args: DepositForBurnArgs): `0x${string}` {
  const hookBytes = byteLength(args.hookData, "hookData");
  const paddedChars = Math.ceil(hookBytes / 32) * 32 * 2;

  const head = [
    word(args.amount, "amount"),
    word(BigInt(args.destinationDomain), "destinationDomain"),
    bytes32Word(args.mintRecipient, "mintRecipient"),
    addressWord(args.burnToken, "burnToken"),
    bytes32Word(args.destinationCaller, "destinationCaller"),
    word(args.maxFee, "maxFee"),
    word(BigInt(args.minFinalityThreshold), "minFinalityThreshold"),
    word(HEAD_WORDS * 32n, "hookDataOffset"),
  ].join("");

  const tail =
    word(BigInt(hookBytes), "hookData.length") +
    args.hookData.slice(2).toLowerCase().padEnd(paddedChars, "0");

  return `0x${toHex(selector(DEPOSIT_FOR_BURN_WITH_HOOK))}${head}${tail}`;
}

/**
 * Validate an address against EIP-55 and return it unchanged.
 *
 * A mis-typed address is unrecoverable, and the checksum catches almost every
 * single-character slip. Configuration is validated once at construction so a
 * bad chain entry fails loudly instead of at signing time.
 */
export function assertChecksumAddress(value: string, field: string): `0x${string}` {
  if (!ADDRESS.test(value)) throw new Error(`${field} must be a 20-byte hex address.`);
  const body = value.slice(2);
  const lower = body.toLowerCase();
  // An all-one-case address carries no checksum information; accept it.
  if (body === lower || body === body.toUpperCase()) return value as `0x${string}`;
  const hash = toHex(keccak_256(new TextEncoder().encode(lower)));
  for (let i = 0; i < body.length; i += 1) {
    const expected =
      Number.parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
    if (body[i] !== expected) {
      throw new Error(`${field} fails its EIP-55 checksum; verify the address.`);
    }
  }
  return value as `0x${string}`;
}
