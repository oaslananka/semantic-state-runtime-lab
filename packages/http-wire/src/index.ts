export type WireErrorFactory = (message: string) => Error;

export function normalizedMediaType(headers: Headers): string | undefined {
  return headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

export async function collectBoundedBytes(input: {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly contentLength: string | null;
  readonly maxBytes: number;
  readonly invalidLength: WireErrorFactory;
  readonly tooLarge: WireErrorFactory;
}): Promise<Uint8Array> {
  if (input.contentLength !== null) {
    const declared = Number(input.contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) throw input.invalidLength("Invalid Content-Length");
    if (declared > input.maxBytes) throw input.tooLarge("Body exceeds configured byte limit");
  }
  if (input.body === null) return new Uint8Array();

  const reader = input.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > input.maxBytes) {
        await reader.cancel();
        throw input.tooLarge("Body exceeds configured byte limit");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function parseUtf8Json(
  bytes: Uint8Array,
  invalidUtf8: WireErrorFactory,
  invalidJson: WireErrorFactory,
): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidUtf8("Body is not valid UTF-8 JSON");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidJson("Body is not valid JSON");
  }
}

export function objectRecord(
  value: unknown,
  label: string,
  invalid: WireErrorFactory,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function exactObjectKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
  invalid: WireErrorFactory,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw invalid(`${label} contains unsupported fields`);
  }
}

export function nonEmptyString(
  value: unknown,
  label: string,
  invalid: WireErrorFactory,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(`${label} must be a non-empty string`);
  }
  return value;
}

export function positiveInteger(
  value: unknown,
  label: string,
  invalid: WireErrorFactory,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalid(`${label} must be a positive integer`);
  }
  return value as number;
}

export function uniqueHostnames(values: readonly string[], label: string): ReadonlySet<string> {
  const normalized = values.map((value) => value.trim().toLowerCase());
  if (normalized.length === 0 || normalized.some((value) => value.length === 0)) {
    throw new TypeError(`${label} must contain non-empty hostnames`);
  }
  return new Set(normalized);
}

export function hostnameFromHostHeader(
  value: string,
  invalid: WireErrorFactory,
): string {
  try {
    const authority = value.trim();
    if (authority.length === 0 || authority !== value) throw new Error("invalid host whitespace");
    const parsed = new URL(`http://${authority}`);
    if (
      parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.pathname !== "/"
      || parsed.search.length > 0
      || parsed.hash.length > 0
    ) {
      throw new Error("invalid host authority");
    }
    return parsed.hostname.toLowerCase();
  } catch {
    throw invalid("Invalid request host");
  }
}

export function validateRequestHost(input: {
  readonly request: Request;
  readonly allowed: ReadonlySet<string>;
  readonly invalidHost: WireErrorFactory;
  readonly notAllowed: WireErrorFactory;
}): void {
  const urlHostname = new URL(input.request.url).hostname.toLowerCase();
  if (!input.allowed.has(urlHostname)) throw input.notAllowed("Request host is not allowed");
  const host = input.request.headers.get("host");
  if (
    host !== null
    && !input.allowed.has(hostnameFromHostHeader(host, input.invalidHost))
  ) {
    throw input.notAllowed("Request host is not allowed");
  }
}

export function validateRequestOrigin(input: {
  readonly request: Request;
  readonly allowed: ReadonlySet<string>;
  readonly notAllowed: WireErrorFactory;
}): void {
  const origin = input.request.headers.get("origin");
  if (origin === null) return;
  let hostname: string;
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.pathname !== "/"
      || parsed.search.length > 0
      || parsed.hash.length > 0
    ) {
      throw new Error("invalid origin");
    }
    hostname = parsed.hostname.toLowerCase();
  } catch {
    throw input.notAllowed("Request origin is not allowed");
  }
  if (!input.allowed.has(hostname)) throw input.notAllowed("Request origin is not allowed");
}

export function secureHttpBaseUrl(value: URL, label: string): URL {
  const url = new URL(value.toString());
  const loopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]"
    || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError(`${label} requires HTTPS outside loopback`);
  }
  return url;
}
