import type { PluginApi } from '@openeverest/plugin-sdk';

// The host hands these in through register(api). `api.fetch` prefixes the
// plugin's proxy base (/v1/clusters/{cluster}/plugins/betterdb) and adds the
// user's Authorization header, which the backend forwards to OpenEverest as
// its authorization check.

export let pluginFetch: PluginApi['fetch'];
export let cssNonce: PluginApi['cssNonce'];
export let clusterName = 'main';

export function initPluginApi(api: PluginApi): void {
  pluginFetch = api.fetch.bind(api);
  cssNonce = api.cssNonce;
  // basePath is /v1/clusters/{cluster}/plugins/{pluginName}; the tab props do
  // not carry the cluster name, so it is taken from here.
  const match = /^\/v1\/clusters\/([^/]+)\//.exec(api.basePath ?? '');
  if (match) {
    clusterName = decodeURIComponent(match[1]);
  }
}
