/**
 * Post-build script: replaces telemetry placeholder tokens in compiled JS
 * with values from environment variables (POSTHOG_API_KEY, POSTHOG_HOST).
 *
 * If the env vars are not set, the placeholders remain and the factory
 * treats them as unset (falls back to noop analytics).
 *
 * With REQUIRE_TELEMETRY_KEY set (release builds) the script instead fails
 * loudly rather than publishing a package that silently reports nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const targetPath = resolve(__dirname, '../dist/analytics.js');

const API_KEY_PLACEHOLDER = '__BETTERDB_POSTHOG_API_KEY__';
const HOST_PLACEHOLDER = '__BETTERDB_POSTHOG_HOST__';

const replacements = {
  [API_KEY_PLACEHOLDER]: process.env.POSTHOG_API_KEY,
  [HOST_PLACEHOLDER]: process.env.POSTHOG_HOST,
};

const originalSource = readFileSync(targetPath, 'utf8');
let source = originalSource;
let replaced = 0;

for (const [placeholder, value] of Object.entries(replacements)) {
  if (value && source.includes(placeholder)) {
    source = source.replaceAll(placeholder, value);
    replaced++;
  }
}

if (replaced > 0) {
  writeFileSync(targetPath, source);
  console.log(`Injected ${replaced} telemetry default(s) into analytics build output.`);
} else {
  console.log('No telemetry env vars set — placeholders left as-is (noop fallback).');
}

if (!process.env.REQUIRE_TELEMETRY_KEY) {
  process.exit(0);
}

// A build output with no placeholder to substitute is not proof of success: the
// token may have been renamed in src, in which case nothing was injected and
// every check below would pass while shipping a telemetry-blind build.
if (!originalSource.includes(API_KEY_PLACEHOLDER)) {
  console.error(
    `REQUIRE_TELEMETRY_KEY is set but ${API_KEY_PLACEHOLDER} was not found in the build output — the token was renamed or the file was already injected. Refusing to ship a build whose telemetry key cannot be verified.`,
  );
  process.exit(1);
}

if (source.includes(API_KEY_PLACEHOLDER)) {
  console.error(
    `REQUIRE_TELEMETRY_KEY is set but ${API_KEY_PLACEHOLDER} was not injected — refusing to ship a telemetry-blind build.`,
  );
  process.exit(1);
}
