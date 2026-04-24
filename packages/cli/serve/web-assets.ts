/**
 * Static asset resolver for `me serve`.
 *
 * Wraps the auto-generated `web-assets.generated.ts` (produced by
 * `scripts/bundle-web-assets.ts`) and exposes a single resolver that returns
 * a `Response` for any request path.
 *
 * Behavior:
 * - Exact match in the embedded map → serve the file.
 * - `GET /` → serve `/index.html`.
 * - Anything else that doesn't look like an asset (no dot in the last
 *   segment) falls back to `/index.html` to support the React SPA.
 * - Asset paths (with an extension) that don't exist → 404.
 * - If the embedded map is empty (no production build was bundled in), serve
 *   a friendly placeholder page that points the user at the dev server or
 *   the build command.
 */
import { type EmbeddedAsset, webAssets } from "./web-assets.generated.ts";

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Memory Engine (dev)</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        margin: 0;
        background: #f8fafc;
        color: #0f172a;
      }
      .card {
        max-width: 36rem;
        text-align: left;
        background: white;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        padding: 2rem 2.5rem;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
      }
      code {
        background: #e2e8f0;
        padding: 0.1em 0.4em;
        border-radius: 4px;
        font-size: 0.875em;
      }
      h1 { margin-top: 0; }
      p { line-height: 1.6; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Memory Engine</h1>
      <p>
        This <code>me serve</code> build does not have the web UI embedded.
      </p>
      <p>
        <strong>Developing?</strong> Open the Vite dev server instead:
        <code>cd packages/web &amp;&amp; ../../bun run dev</code> and visit
        <code>http://localhost:5173</code>. The dev server proxies
        <code>/rpc</code> back to this server.
      </p>
      <p>
        <strong>Embedding the UI?</strong> Run
        <code>./bun scripts/bundle-web-assets.ts</code> after
        <code>cd packages/web &amp;&amp; ../../bun run build</code>, then
        restart <code>me serve</code>.
      </p>
    </div>
  </body>
</html>
`;

/**
 * True when the binary has embedded assets. Used by the HTTP server to
 * decide between SPA fallback and the placeholder page.
 */
export const hasEmbeddedUi: boolean = webAssets.size > 0;

/**
 * Resolve a request path to a Response.
 *
 * The caller is responsible for routing `/rpc`, `/healthz`, etc. before
 * reaching this function — it always returns a 200 asset, a 200 index.html
 * fallback, or a 404 for missing asset-shaped paths.
 */
export function resolveAssetResponse(pathname: string): Response {
  if (!hasEmbeddedUi) {
    return new Response(PLACEHOLDER_HTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const target = pathname === "/" ? "/index.html" : pathname;
  const direct = webAssets.get(target);
  if (direct) return assetResponse(direct, target);

  // SPA fallback: anything without a file extension is a client-side route.
  if (!hasExtension(target)) {
    const index = webAssets.get("/index.html");
    if (index) return assetResponse(index, "/index.html");
  }

  return new Response("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function assetResponse(asset: EmbeddedAsset, path: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": asset.contentType,
  };
  // Hashed Vite assets under /assets/ are immutable — cache aggressively.
  // index.html must revalidate so UI updates land on next load.
  if (path.startsWith("/assets/")) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  } else {
    headers["Cache-Control"] = "no-cache";
  }
  return new Response(asset.data, { status: 200, headers });
}

function hasExtension(path: string): boolean {
  const lastSlash = path.lastIndexOf("/");
  const lastSegment = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  return lastSegment.includes(".");
}
