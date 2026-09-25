import { canonicalJson } from "@ssrl/core";

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export class E2EValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "E2EValidationError";
  }
}

export class E2ECryptoError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "E2ECryptoError";
  }
}

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(value);
  const copy = new Uint8Array(encoded.byteLength);
  copy.set(encoded);
  return copy;
}

export function bytesCopy(
  value: ArrayBufferLike | ArrayBufferView,
): Uint8Array<ArrayBuffer> {
  const source = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

export function base64UrlEncode(value: ArrayBufferLike | ArrayBufferView): string {
  const bytes = bytesCopy(value);
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    for (const byte of chunk) binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodedBase64UrlLength(value: string): number {
  if (!BASE64URL.test(value) || value.length % 4 === 1) {
    throw new E2EValidationError("value must be unpadded base64url");
  }
  const fullQuads = Math.floor(value.length / 4);
  const remainder = value.length % 4;
  return fullQuads * 3 + (remainder === 0 ? 0 : remainder - 1);
}

export function base64UrlDecode(
  value: string,
  label: string,
  options: { readonly exactBytes?: number; readonly maxBytes?: number } = {},
): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !BASE64URL.test(value) || value.length % 4 === 1) {
    throw new E2EValidationError(`${label} must be unpadded base64url`);
  }
  const decodedLength = decodedBase64UrlLength(value);
  if (options.exactBytes !== undefined && decodedLength !== options.exactBytes) {
    throw new E2EValidationError(`${label} must decode to exactly ${options.exactBytes} bytes`);
  }
  if (options.maxBytes !== undefined && decodedLength > options.maxBytes) {
    throw new E2EValidationError(`${label} exceeds ${options.maxBytes} bytes`);
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch (cause) {
    throw new E2EValidationError(`${label} is not valid base64url`, { cause });
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (base64UrlEncode(bytes) !== value) {
    throw new E2EValidationError(`${label} must use canonical unpadded base64url`);
  }
  return bytes;
}

export function requiredString(value: unknown, label: string, maxLength = 1_024): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new E2EValidationError(`${label} must be a non-empty string up to ${maxLength} characters`);
  }
  return value;
}

export function requiredSafeInteger(value: unknown, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new E2EValidationError(`${label} must be a non-negative safe integer up to ${max}`);
  }
  return value as number;
}

export function plainObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new E2EValidationError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new E2EValidationError(`${label} must be a plain object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function exactObjectKeys(
  object: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(object).toSorted();
  const wanted = [...expected].toSorted();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new E2EValidationError(`${label} has unexpected or missing fields`);
  }
}

export function parseJsonObject(value: string, label: string, maxChars: number): Readonly<Record<string, unknown>> {
  if (typeof value !== "string" || value.length > maxChars) {
    throw new E2EValidationError(`${label} exceeds its encoded size limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (cause) {
    throw new E2EValidationError(`${label} is not valid JSON`, { cause });
  }
  return plainObject(parsed, label);
}

export async function sha256(
  value: ArrayBufferLike | ArrayBufferView,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = bytesCopy(value);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

export function canonicalBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return utf8(canonicalJson(value));
}
