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
