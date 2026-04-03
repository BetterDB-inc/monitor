/**
 * Post-build script: replaces telemetry placeholder tokens in compiled JS
 * with values from environment variables (POSTHOG_API_KEY, POSTHOG_HOST).
 *
 * If the env vars are not set, the placeholders remain and the factory
 * treats them as unset (falls back to HTTP telemetry).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const factoryPath = resolve(
  __dirname,
  '../dist/apps/api/src/telemetry/telemetry-client.factory.js',
);

const replacements = {
  __BETTERDB_POSTHOG_API_KEY__: process.env.POSTHOG_API_KEY,
  __BETTERDB_POSTHOG_HOST__: process.env.POSTHOG_HOST,
};

let source = readFileSync(factoryPath, 'utf8');
let replaced = 0;

for (const [placeholder, value] of Object.entries(replacements)) {
  if (value && source.includes(placeholder)) {
    source = source.replace(placeholder, value);
    replaced++;
  }
}

if (replaced > 0) {
  writeFileSync(factoryPath, source);
  console.log(`Injected ${replaced} telemetry default(s) into factory build output.`);
} else {
  console.log('No telemetry env vars set — placeholders left as-is (HTTP fallback).');
}
