const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const INDEX = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i += 1) INDEX.set(ALPHABET[i]!, i);

export function decodeBase58(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array();
  const bytes: number[] = [];
  for (const character of value) {
    let carry = INDEX.get(character);
    if (carry === undefined) {
      throw new Error(`"${character}" is not a base58 character.`);
    }
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Each leading "1" encodes one leading zero byte.
  for (let i = 0; i < value.length && value[i] === "1"; i += 1) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let prefix = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i += 1) prefix += "1";
  return prefix + digits.reverse().map((digit) => ALPHABET[digit]!).join("");
}

/** Render a Solana address as the 32-byte hex form used by EVM bridge calls. */
export function toBytes32(address: string): `0x${string}` {
  const bytes = decodeBase58(address);
  if (bytes.length !== 32) {
    throw new Error("A Solana address must decode to exactly thirty-two bytes.");
  }
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
