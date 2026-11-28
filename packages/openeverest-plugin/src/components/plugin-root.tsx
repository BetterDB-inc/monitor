import type { ReactNode } from 'react';
import { PluginThemeProvider } from '@openeverest/plugin-theme';
import { cssNonce } from '../plugin-api';

// Every mounted component sits under the host-aware MUI theme. The cache key
// scopes Emotion's class names to this plugin; no global CSS is emitted.
const EMOTION_CACHE_KEY = 'betterdb';

export const PluginRoot = ({ children }: { children: ReactNode }) => (
  <PluginThemeProvider cacheKey={EMOTION_CACHE_KEY} nonce={cssNonce}>
    {children}
  </PluginThemeProvider>
);
