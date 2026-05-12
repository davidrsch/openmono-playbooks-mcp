/**
 * esbuild bundler config for the MCP stdio server.
 *
 * `tsc` compiles src/ → dist/ with declaration files and source maps,
 * then this script bundles dist/index.js → dist/index.js (in-place)
 * so all dependencies are inlined and the server runs self-contained
 * inside a VS Code extension without node_modules available.
 */
import * as esbuild from "esbuild";

const result = await esbuild.build({
  entryPoints: ["dist/index.js"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: "dist/index.js",
  allowOverwrite: true,
  banner: {
    js: `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);`,
  },
  external: [
    // VS Code provides this at runtime; other node:* builtins are bundled
    "vscode",
  ],
  sourcemap: true,
  minify: false,
  keepNames: true,
});

if (result.errors.length > 0) {
  console.error("esbuild errors:", result.errors);
  process.exit(1);
}

if (result.warnings.length > 0) {
  console.warn("esbuild warnings:", result.warnings);
}

console.log("✅ Server bundled successfully");
