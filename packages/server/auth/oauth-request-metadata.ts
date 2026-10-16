import { createHash } from "node:crypto";

const TOKEN_PATH = "/api/v1/auth/oauth2/token";
const MAX_METADATA_BODY_BYTES = 8 * 1024;
const METADATA_READ_TIMEOUT_MS = 250;
const GRANT_TYPES = new Set([
  "authorization_code",
  "refresh_token",
  "client_credentials",
  "urn:ietf:params:oauth:grant-type:token-exchange",
]);

/** Read only a small clone, concurrently with the real handler. Never retain or
 * export the body. Slow/oversized/consumed/unreadable bodies omit diagnostics. */
export async function readTelemetryBody(
  source: Request | Response,
): Promise<string | undefined> {
  const declared = Number(source.headers.get("content-length"));
  if (declared > MAX_METADATA_BODY_BYTES) return undefined;
  let reader:
    | Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel">
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    reader = source.clone().body?.getReader();
    if (!reader) return undefined;
    const stopped = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), METADATA_READ_TIMEOUT_MS);
    });
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const next = await Promise.race([reader.read(), stopped]);
      if (!next) return undefined;
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_METADATA_BODY_BYTES) return undefined;
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
    // A tee's cancel promise may wait for the real handler's branch. Never
    // await it: optional diagnostics cannot block the response or consume it.
    void reader?.cancel().catch(() => {});
  }
}

/** The token endpoint is unauthenticated. These are caller-provided diagnostic
 * hints, never authenticated identity. Unknown client IDs are hashed so an
 * arbitrary value placed in client_id cannot exfiltrate a secret into traces. */
export async function tokenRequestTelemetryAttributes(
  request: Request,
): Promise<Record<string, string>> {
  if (new URL(request.url).pathname !== TOKEN_PATH || request.method !== "POST")
    return {};
  const type = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    type !== "application/x-www-form-urlencoded" &&
    type !== "application/json"
  )
    return {};
  const text = await readTelemetryBody(request);
  if (text === undefined) return {};
  try {
    let grant: unknown;
    let client: unknown;
    if (type === "application/json") {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
      grant = (value as Record<string, unknown>).grant_type;
      client = (value as Record<string, unknown>).client_id;
    } else {
      const params = new URLSearchParams(text);
      // Ambiguous duplicate fields are not useful attribution evidence.
      grant =
        params.getAll("grant_type").length === 1
          ? params.get("grant_type")
          : undefined;
      client =
        params.getAll("client_id").length === 1
          ? params.get("client_id")
          : undefined;
    }
    const attributes: Record<string, string> = {};
    if (typeof grant === "string")
      attributes["oauth.grant.type"] = GRANT_TYPES.has(grant) ? grant : "other";
    if (typeof client === "string" && /^[A-Za-z0-9._~-]{1,128}$/.test(client)) {
      attributes["oauth.client_id"] = client === "me-cli" ? "me-cli" : "other";
      if (client !== "me-cli")
        attributes["oauth.client_id_hash"] = createHash("sha256")
          .update(`oauth.client_id:${client}`)
          .digest("hex");
    }
    return attributes;
  } catch {
    return {};
  }
}
