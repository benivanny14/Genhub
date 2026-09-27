// =============================================================================
// GENHUB - the dev server the trimmer browser test runs against
//
// The browser test drives the REAL VideoTrimmer component: not a mock, not a
// copy of its arithmetic. Next is the app's own server, but booting Next (with
// Prisma, auth and every route) to test one client component would make the
// test depend on the whole product. This tiny Vite server mounts the component
// instead, reusing the app's own `@` alias and its real PostCSS/Tailwind
// pipeline, so what the test clicks is laid out and styled exactly as it is in
// the upload flow.
//
// Root stays the repository root so `src/…`, the fixture under `e2e/fixtures/`
// and the root `postcss.config.js` are all served and resolved as they are in
// the app.
// =============================================================================

import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  root,
  // tsconfig keeps `jsx: "preserve"` for Next, and Vite honours it — which
  // leaves the harness's JSX untransformed. The automatic runtime is what the
  // component expects.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: { "@": path.resolve(root, "src") },
  },
  server: {
    host: "127.0.0.1",
    port: 5199,
    strictPort: true,
  },
});
