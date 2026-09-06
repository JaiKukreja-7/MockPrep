import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs-dist falls back to a "fake worker" that imports pdf.worker.mjs by
  // path. Bundled by Turbopack that import cannot resolve, and PDF parsing
  // dies with "Setting up fake worker failed". Leaving these external means
  // they are required from node_modules at runtime, which is how they expect
  // to resolve their own internals.
  serverExternalPackages: ["pdfjs-dist", "mammoth"],
  experimental: {
    serverActions: {
      // Resume uploads are capped at 4MB in lib/resume/extract.ts. The limit
      // here covers the raw HTTP body, which also carries multipart
      // boundaries and part headers, so it needs headroom above the file cap
      // or a 4MB file is rejected by the transport before our own check runs.
      bodySizeLimit: "5mb",
    },
  },
};

export default nextConfig;
