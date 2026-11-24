# @betterdb/openeverest-plugin

Frontend of the BetterDB plugin for [OpenEverest](https://openeverest.io). It is built the way
`openeverest/generic-plugin-template` builds a plugin: one ESM bundle (`dist/main.js`) the
OpenEverest UI imports at runtime, MUI styled through `@openeverest/plugin-theme`, React taken
from the host's import map. No global CSS, no iframes.

It contributes two extension points, both declared in the Plugin CR that
`charts/betterdb-openeverest` installs:

- `clusterDetailTab` **BetterDB** on Valkey instances (`providers: [valkey]`): the monitoring
  state (Off, Connecting, Monitoring, Error), per-node connection status, an Enable/Disable
  button and a link to BetterDB.
- `settingsPanel` **BetterDB**: the BetterDB agent URL and token, stored by the backend in a
  Secret in the plugin namespace.

The backend is the `betterdb/agent` image in `openeverest` mode (`packages/agent/src/openeverest`),
which also serves this bundle at `/main.js`. The agent Dockerfile builds the bundle into the image.

```bash
pnpm --filter @betterdb/openeverest-plugin build   # dist/main.js + dist/icon.svg
pnpm --filter @betterdb/openeverest-plugin test
```
