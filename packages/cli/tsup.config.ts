import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  // `sqlite` only exists as `node:sqlite`; stripping the prefix breaks the import.
  removeNodeProtocol: false,
  // Workspace packages are bundled in; only `agentprism` itself is published.
  noExternal: [/^@agentprism\//],
});
