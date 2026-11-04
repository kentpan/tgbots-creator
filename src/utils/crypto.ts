import { randomInt } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function generateVerificationToken(length = 32): string {
  let token = "";
  for (let i = 0; i < length; i++) {
    token += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return token;
}

export function generateSessionId(length = 16): string {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = randomInt(0, 256);
  }
  return Buffer.from(bytes).toString("base64url");
}
