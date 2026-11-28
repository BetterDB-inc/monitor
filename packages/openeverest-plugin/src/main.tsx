import type { PluginApi, PluginRegisterFn } from '@openeverest/plugin-sdk';
import { initPluginApi } from './plugin-api';
import { BetterDbTab } from './components/betterdb-tab';
import { SettingsPanel } from './components/settings-panel';

// The host imports this bundle and calls register(api) once at startup. The
// Plugin CR in charts/betterdb-openeverest lists the same two extension
// points; the host rejects any type not declared there.
const register: PluginRegisterFn = (api: PluginApi) => {
  initPluginApi(api);

  // BetterDB tab on each Valkey instance. `providers` is matched against
  // spec.providerRef.name, so the tab stays off other engines.
  api.registerExtension({
    type: 'clusterDetailTab',
    label: 'BetterDB',
    path: 'betterdb',
    component: BetterDbTab,
    providers: ['valkey'],
  });

  // Where to send the data: BetterDB URL and agent token.
  api.registerExtension({
    type: 'settingsPanel',
    label: 'BetterDB',
    path: 'betterdb',
    component: SettingsPanel,
  });
};

export default register;
