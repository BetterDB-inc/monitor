#!/usr/bin/env node

// Bundles the agent into a single self-contained dist/index.js.
//
// The key reason this uses esbuild instead of plain `tsc`: the agent imports
// @betterdb/shared (extractPattern, checkBlocked, pruneKeyDetails, protocol
// types), which is a PRIVATE, unpublished workspace package. `tsc` leaves a bare
// `require('@betterdb/shared')` in the output, so every distribution channel that
// doesn't also ship shared breaks at runtime:
//   - npm  (`npx @betterdb/agent`): the release workflow strips the workspace dep
//     before publish, so the module is simply absent -> "Cannot find module
//     '@betterdb/shared'".
//   - Docker: shared has to be vendored + resolved via a file: dependency, which
//     is fragile (and previously also failed to resolve shared's own `zod`).
// Bundling inlines @betterdb/shared into the output, so the published package and
// the image no longer have to vendor or resolve it at runtime.
//
// Everything declared in package.json `dependencies` (AWS SDK, iovalkey, ws, zod)
// is kept EXTERNAL and installed by npm as usual. zod in particular is a normal,
// published package: keeping it external means it lands in node_modules where a
// scanner can see its version, rather than being baked into dist/index.js where a
// CVE would be invisible. @betterdb/shared lives in devDependencies (it is private
// and unpublishable), so it is absent from this list and gets inlined.

import { build } from 'esbuild';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const agentRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(agentRoot, 'package.json'), 'utf-8'));

// Externalize exactly the declared runtime dependencies (AWS SDK, iovalkey, ws,
// zod). @betterdb/shared is deliberately absent from `dependencies`, so esbuild
// inlines it.
const external = Object.keys(pkg.dependencies ?? {});

await build({
  entryPoints: [join(agentRoot, 'src/index.ts')],
  outfile: join(agentRoot, 'dist/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external,
  // esbuild preserves the `#!/usr/bin/env node` shebang already present at the top
  // of src/index.ts, so the published `bin` stays executable — no banner needed.
  logLevel: 'info',
});
