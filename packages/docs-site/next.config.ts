import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  // Pin workspace root so Turbopack does not climb the directory tree and
  // pick up unrelated lockfiles (e.g. ~/package-lock.json).
  turbopack: { root: path.resolve(__dirname, "..", "..") },
};

export default nextConfig;
