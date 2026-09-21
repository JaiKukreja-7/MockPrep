import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone is for the Docker/Cloud Run path: it traces the server and
  // the slice of node_modules it needs into .next/standalone, which the
  // Dockerfile's final stage copies. Not on Vercel — its adapter packages
  // functions itself and does not write .next/next-server.js.nft.json, and
  // the standalone copy step runs right after the adapter hook and opens
  // that file (build/utils.js copyTracedFiles), failing the build with
  // ENOENT. Next's own build code notes the two may become mutually
  // exclusive. Vercel sets VERCEL=1 in every build.
  output: process.env.VERCEL ? undefined : "standalone",

  // pdfjs-dist falls back to a "fake worker" that imports pdf.worker.mjs by
  // path. Bundled by Turbopack that import cannot resolve, and PDF parsing
  // dies with "Setting up fake worker failed". Leaving these external means
  // they are required from node_modules at runtime, which is how they expect
  // to resolve their own internals.
  serverExternalPackages: ["pdfjs-dist", "mammoth"],

  // Vercel builds each route's function from Next's output file trace. pdfjs
  // is external (above), and in Node it loads its worker with a runtime
  // `import("./pdf.worker.mjs")` that the tracer cannot see — so the file
  // was absent from the /resume function and every upload would have failed
  // with "Setting up fake worker failed". The resume upload is a server
  // action posted to /resume, so that is the route that needs it.
  outputFileTracingIncludes: {
    "/resume": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
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
