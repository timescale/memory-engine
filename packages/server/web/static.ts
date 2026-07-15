/**
 * Static web-UI serving for the hosted server.
 *
 * Serves the Vite build from disk (`webDist`) at the site root, with similar
 * single-page-app semantics to `me serve` (the CLI's
 * `packages/cli/serve/web-assets.ts`): exact asset match → file, client-side
 * route → `index.html`, missing asset → 404. Most client routes are
 * extension-less, but invite tokens are `inv.<secret>`, so `/invite/...` must be
 * treated as a route even though the final segment contains a dot. The CLI
 * embeds the build in its binary; the server reads it from the container
 * filesystem instead.
 *
 * When serving `index.html` we inject `window.__ME_BOOTSTRAP__` so the same
 * build knows it is running in **hosted** mode (the absence of this script is
 * what keeps `me serve` in local mode). The token never appears here — auth is
 * the httpOnly session cookie.
 */
import { extname, resolve, sep } from "node:path";

export interface StaticHandler {
  /** Resolve a GET/HEAD request to an asset, SPA fallback, or 404. */
  handle(request: Request, pathname: string): Promise<Response>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function isClientRoute(target: string): boolean {
  return extname(target) === "" || target.startsWith("/invite/");
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><title>Memory Engine</title></head>
<body style="font-family:-apple-system,sans-serif;padding:2rem">
<h1>Memory Engine</h1>
<p>The web UI is not built in this deployment. Build it with
<code>cd packages/web &amp;&amp; ../../bun run build</code> and ensure
<code>WEB_DIST</code> points at <code>packages/web/dist</code>.</p>
</body></html>`;

/**
 * Create a static handler bound to a built UI directory and a bootstrap object
 * (injected into index.html so the app boots in hosted mode).
 */
export function createStaticHandler(opts: {
  webDist: string;
  bootstrap: Record<string, unknown>;
}): StaticHandler {
  const distRoot = resolve(opts.webDist);
  // Escape `<` so a value can never break out of the injected <script> tag.
  const bootstrapInline = `window.__ME_BOOTSTRAP__ = ${JSON.stringify(
    opts.bootstrap,
  ).replace(/</g, "\\u003c")};`;
  const bootstrapScript = `<script>${bootstrapInline}</script>`;

  // Security headers for every served response. The CSP is tuned to the Vite
  // build + this app's dependencies:
  // - Scripts: Vite emits only external (hashed) `/assets` scripts, covered by
  //   `'self'`; the single inline script — our bootstrap — is allow-listed by
  //   its exact sha256, so we never need `'unsafe-inline'` for scripts.
  // - `style-src 'unsafe-inline'`: Monaco injects theme `<style>` blocks at
  //   runtime, and the placeholder page uses markup `style=""` attributes.
  // - `worker-src 'self' blob:`: Monaco spawns same-origin `/assets` workers,
  //   with a blob-URL fallback for its cross-origin worker shim.
  // - `img-src ... https:`: rendered memory markdown may embed remote images.
  // - `frame-ancestors 'none'` + `X-Frame-Options: DENY` stop clickjacking of
  //   the authenticated app.
  const bootstrapHash = new Bun.CryptoHasher("sha256")
    .update(bootstrapInline)
    .digest("base64");
  const CSP = [
    "default-src 'self'",
    `script-src 'self' 'sha256-${bootstrapHash}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  /** Map a URL path to an absolute file path inside distRoot, or null if it escapes. */
  function fsPathFor(pathname: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    const full = resolve(
      distRoot,
      `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`,
    );
    if (full !== distRoot && !full.startsWith(distRoot + sep)) return null;
    return full;
  }

  function bodyResponse(
    request: Request,
    body: string | ArrayBuffer,
    contentType: string,
    cacheControl: string,
    status = 200,
  ): Response {
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": CSP,
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
    };
    // HEAD: same headers, no body.
    if (request.method === "HEAD")
      return new Response(null, { status, headers });
    return new Response(body, { status, headers });
  }

  async function serveIndex(request: Request): Promise<Response> {
    const indexPath = fsPathFor("/index.html");
    const file = indexPath ? Bun.file(indexPath) : null;
    if (!file || !(await file.exists())) {
      return bodyResponse(
        request,
        PLACEHOLDER_HTML,
        "text/html; charset=utf-8",
        "no-cache",
        200,
      );
    }
    const html = await file.text();
    // index.html must revalidate so UI updates land on next load. Inject the
    // hosted-mode bootstrap before </head> (fall back to prepending the script).
    const injected = html.includes("</head>")
      ? html.replace("</head>", `${bootstrapScript}</head>`)
      : bootstrapScript + html;
    return bodyResponse(
      request,
      injected,
      "text/html; charset=utf-8",
      "no-cache",
    );
  }

  return {
    async handle(request, pathname) {
      const target = pathname === "/" ? "/index.html" : pathname;

      if (target === "/index.html") return serveIndex(request);

      const fsPath = fsPathFor(target);
      if (fsPath) {
        const file = Bun.file(fsPath);
        if (await file.exists()) {
          // Hashed Vite assets under /assets/ are immutable; everything else
          // revalidates.
          const cacheControl = target.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache";
          return bodyResponse(
            request,
            await file.arrayBuffer(),
            contentTypeFor(target),
            cacheControl,
          );
        }
      }

      // SPA fallback: client-side routes → index.html. Invite tokens are
      // dot-bearing (`inv.<secret>`), so extension checks alone would 404 them
      // before React can redeem the token.
      if (isClientRoute(target)) return serveIndex(request);

      return new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    },
  };
}
