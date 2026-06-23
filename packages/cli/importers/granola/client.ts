/**
 * Minimal Granola HTTP API client.
 *
 * Granola's desktop app talks to `api.granola.ai` with a WorkOS bearer token
 * plus a client-version header — the server rejects requests without a
 * recognized `X-Client-Version` ("Unsupported client"). We mirror those
 * headers and refresh the (short-lived) access token through
 * `/v1/refresh-access-token` before the first data call, so an import works
 * even when Granola's on-disk access token has expired.
 *
 * Only the read endpoints the importer needs are wrapped:
 *   - `POST /v2/get-documents`         → meeting metadata + AI notes (paged by offset)
 *   - `POST /v1/get-document-panels`   → per-meeting AI summary panels (rich notes)
 *   - `POST /v1/get-document-transcript` → per-meeting transcript segments
 */

/** Base URL for Granola's API. */
const API_BASE = "https://api.granola.ai";
/**
 * Client version sent as `X-Client-Version`. The server gates on a recognized
 * value; this tracks a known-good desktop release. Overridable via
 * `GRANOLA_CLIENT_VERSION` if Granola tightens the gate.
 */
const DEFAULT_CLIENT_VERSION = "7.356.2";

function clientVersion(): string {
  return process.env.GRANOLA_CLIENT_VERSION || DEFAULT_CLIENT_VERSION;
}

/** Thrown for any non-2xx Granola API response. */
export class GranolaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GranolaApiError";
  }
}

/** One meeting document as returned by `get-documents` (only fields we read). */
export interface GranolaDocument {
  id: string;
  title?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  notes_markdown?: string | null;
  notes_plain?: string | null;
  /** ProseMirror notes doc, when present. */
  notes?: unknown;
  summary?: string | null;
  overview?: string | null;
  valid_meeting?: boolean | null;
  deleted_at?: string | null;
  google_calendar_event?: GranolaCalendarEvent | null;
  people?: unknown;
  workspace_id?: string | null;
}

/** The slice of a meeting's Google Calendar event we surface. */
export interface GranolaCalendarEvent {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{
    email?: string;
    responseStatus?: string;
    self?: boolean;
  }>;
  htmlLink?: string;
}

/** An AI summary panel (rich notes) for a meeting. */
export interface GranolaPanel {
  id: string;
  document_id?: string;
  title?: string | null;
  template_slug?: string | null;
  /** ProseMirror content doc. */
  content?: unknown;
  /** HTML rendering of the panel, when present. */
  original_content?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** One transcript segment for a meeting. */
export interface GranolaTranscriptSegment {
  id?: string;
  document_id?: string;
  start_timestamp?: string;
  end_timestamp?: string;
  text?: string;
  /** "microphone" (the user) vs "system" (everyone else). */
  source?: string;
  is_final?: boolean;
  detected_speaker_name?: string | null;
}

/**
 * A live Granola API session: holds the current access token and refreshes it
 * once up front. Construct via `createGranolaClient`, which performs the
 * refresh, so every data call carries a valid token.
 */
export class GranolaClient {
  private constructor(private accessToken: string) {}

  /**
   * Build a client from a refresh token, exchanging it for a fresh access
   * token. Using the refresh token (rather than the possibly-expired on-disk
   * access token) means an import works regardless of how long Granola has been
   * closed.
   */
  static async create(refreshToken: string): Promise<GranolaClient> {
    const res = await fetch(`${API_BASE}/v1/refresh-access-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Version": clientVersion(),
        "User-Agent": `Granola/${clientVersion()} Electron`,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) {
      throw new GranolaApiError(
        `Granola token refresh failed (HTTP ${res.status}). Re-open the ` +
          `Granola desktop app to refresh its session, then retry.`,
        res.status,
      );
    }
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new GranolaApiError(
        "Granola token refresh returned no access token.",
        res.status,
      );
    }
    return new GranolaClient(body.access_token);
  }

  /** POST a JSON body to a Granola API path and parse the JSON response. */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        "X-Client-Version": clientVersion(),
        "User-Agent": `Granola/${clientVersion()} Electron`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new GranolaApiError(
        `Granola API ${path} failed (HTTP ${res.status}).`,
        res.status,
      );
    }
    return (await res.json()) as T;
  }

  /**
   * Stream every meeting document, paging by offset. Granola returns documents
   * newest-first; we yield each page's docs in order until a short page signals
   * the end.
   */
  async *listDocuments(pageSize = 100): AsyncIterable<GranolaDocument> {
    let offset = 0;
    for (;;) {
      const page = await this.post<{ docs?: GranolaDocument[] }>(
        "/v2/get-documents",
        { limit: pageSize, offset },
      );
      const docs = page.docs ?? [];
      for (const doc of docs) yield doc;
      if (docs.length < pageSize) return;
      offset += docs.length;
    }
  }

  /** Fetch the AI summary panels for one meeting (may be empty). */
  async getPanels(documentId: string): Promise<GranolaPanel[]> {
    const res = await this.post<GranolaPanel[] | { panels?: GranolaPanel[] }>(
      "/v1/get-document-panels",
      { document_id: documentId },
    );
    if (Array.isArray(res)) return res;
    return res.panels ?? [];
  }

  /** Fetch the transcript segments for one meeting (may be empty). */
  async getTranscript(documentId: string): Promise<GranolaTranscriptSegment[]> {
    const res = await this.post<
      GranolaTranscriptSegment[] | { segments?: GranolaTranscriptSegment[] }
    >("/v1/get-document-transcript", { document_id: documentId });
    if (Array.isArray(res)) return res;
    return res.segments ?? [];
  }
}
