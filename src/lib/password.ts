const PBKDF2_ITERATIONS = 100_000;
const HASH_ALGORITHM = "SHA-256";
const HASH_PREFIX = "pbkdf2";
const KEY_LENGTH_BITS = 256;

function toBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations,
      hash: HASH_ALGORITHM,
    },
    keyMaterial,
    KEY_LENGTH_BITS,
  );
}

export async function hashPassword(password: string, saltBase64?: string): Promise<string> {
  const salt = saltBase64
    ? fromBase64(saltBase64)
    : getRandomBytes(16);
  const derived = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `${HASH_PREFIX}$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(derived)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== HASH_PREFIX) return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64(parts[2]);
    expected = fromBase64(parts[3]);
  } catch {
    return false;
  }
  const derived = await deriveBits(password, salt, iterations);
  const derivedBytes = new Uint8Array(derived);
  if (derivedBytes.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= derivedBytes[i] ^ expected[i];
  }
  return mismatch === 0;
}

export function generateSessionToken(): string {
  return toBase64(getRandomBytes(32)).replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    HASH_ALGORITHM,
    new TextEncoder().encode(value) as unknown as BufferSource,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
