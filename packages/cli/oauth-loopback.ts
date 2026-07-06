/**
 * Loopback redirect handler for the `me login` OAuth flow (RFC 8252 §7.3).
 *
 * Binds a short-lived HTTP server on a 127.0.0.1 ephemeral port, sends the user
 * to the authorization server in a browser, and waits for the auth-code
 * redirect to come back to `/callback`. The full callback URL (with
 * `code`/`state`/`iss`) is handed to the caller for the PKCE token exchange.
 *
 * The authorization server registers the loopback redirect without a port
 * (`http://127.0.0.1/callback`) and matches any port at request time, per RFC
 * 8252 — so we are free to bind an ephemeral one here.
 */

/** Minimal HTML-escape for interpolating a (trusted) URL into the result page. */
function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A page the user lands on after authorizing — they return to the terminal. */
function resultPage(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}
h1{font-size:1.25rem}</style></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

/**
 * The page shown after a successful sign-in. When `uiUrl` is given (the web UI
 * origin, i.e. API_BASE_URL), it links the user straight to the UI — the
 * browser already holds a session cookie on that origin from the authorize
 * step, so they land on an authenticated app.
 */
export function successPage(uiUrl?: string): Response {
  const link = uiUrl
    ? ` <a href="${escapeHtml(uiUrl)}" rel="noreferrer" referrerpolicy="no-referrer">Open the Memory Engine UI</a>.`
    : "";
  return resultPage(
    "Signed in",
    `Authentication complete — you can close this tab and return to the terminal.${link}`,
  );
}

export interface LoopbackOptions {
  /** Build the authorize URL for the bound redirect URI. */
  authorizeUrl: (redirectUri: string) => string;
  /** Open the authorize URL in a browser (best-effort). */
  openBrowser: (url: string) => Promise<void>;
  /** Invoked with the authorize URL (e.g. to print it as a manual fallback). */
  onAuthorizeUrl?: (url: string) => void;
  /**
   * Web UI origin (API_BASE_URL). When set, the success page links the user to
   * the UI so they don't have to navigate there manually.
   */
  uiUrl?: string;
  /** Host to bind (default 127.0.0.1). */
  host?: string;
  /** How long to wait for the redirect before giving up (default 5 min). */
  timeoutMs?: number;
}

export class LoopbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopbackError";
  }
}

/**
 * Run the loopback round-trip and resolve with the full callback URL the
 * browser was redirected to. Rejects on timeout or an OAuth `error` redirect.
 */
export function runLoopbackAuth(opts: LoopbackOptions): Promise<string> {
  const host = opts.host ?? "127.0.0.1";
  const timeoutMs = opts.timeoutMs ?? 300_000;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const server = Bun.serve({
      hostname: host,
      port: 0, // ephemeral — the OS picks a free port
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/callback") {
          // Ignore favicon and stray probes — keep waiting for /callback.
          return new Response(null, { status: 204 });
        }

        const error = url.searchParams.get("error");
        const hasCode = url.searchParams.has("code");
        if (!error && !hasCode) {
          return new Response(null, { status: 204 });
        }

        // Stop accepting before settling so the port is released promptly.
        finish();
        if (error) {
          const desc = url.searchParams.get("error_description") ?? error;
          reject(new LoopbackError(`Authorization failed: ${desc}`));
          return resultPage(
            "Sign-in failed",
            "You can close this tab and return to the terminal.",
          );
        }
        resolve(url.toString());
        return successPage(opts.uiUrl);
      },
      error() {
        return new Response("Internal error", { status: 500 });
      },
    });

    function finish() {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Defer the stop so the in-flight response is flushed to the browser.
      setTimeout(() => server.stop(true), 100);
    }

    timer = setTimeout(() => {
      if (settled) return;
      finish();
      reject(
        new LoopbackError(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser redirect.`,
        ),
      );
    }, timeoutMs);

    const redirectUri = `http://${host}:${server.port}/callback`;
    const authorizeUrl = opts.authorizeUrl(redirectUri);
    opts.onAuthorizeUrl?.(authorizeUrl);
    void opts.openBrowser(authorizeUrl);
  });
}
