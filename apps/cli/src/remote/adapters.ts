import { createNodeConnectionAdapters } from "@cove/node-client";
import { tsnetBinaryPath, tsnetControlUrl } from "./tsnet-binary.js";

// Only CLI host policy lives here. A Desktop host supplies its own stable installed-helper
// locator and its own independent Keychain-backed credential provider to the same package.
export const nodeAdapters = createNodeConnectionAdapters({
  tsnet: {
    binaryPath: tsnetBinaryPath,
    controlUrl: tsnetControlUrl,
    warn: (message) => {
      process.stderr.write(`cove: warning: ${message}\n`);
    },
  },
  onSshWarning: (message) => {
    process.stderr.write(`cove-ssh: ${message}\n`);
  },
});
