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
// Bundling inlines @betterdb/shared (and its only runtime dep, zod) into the
// output, so the published package and the image are both self-contained.
//
// The heavy runtime deps declared in package.json `dependencies` (AWS SDK,
// iovalkey, ws) are kept EXTERNAL and installed by npm as usual — bundling the
// AWS SDK is large and brittle, and there's no distribution reason to inline it.
// Everything NOT listed there (i.e. @betterdb/shared, which lives in
// devDependencies, and zod, pulled in transitively) gets bundled.

import { build } from 'esbuild';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const agentRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(agentRoot, 'package.json'), 'utf-8'));

// Externalize exactly the declared runtime dependencies. @betterdb/shared and zod
// are deliberately absent from this list, so esbuild inlines them.
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
