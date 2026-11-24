import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react-swc';

// Built the way openeverest/generic-plugin-template builds its bundle: one ESM
// file the host imports at runtime. React comes from the host's import map and
// is never bundled; MUI, Emotion and the plugin theme are bundled at the
// versions pinned here.
const HOST_PROVIDED = ['react', 'react-dom', 'react/jsx-runtime'];

// A bundled CommonJS dependency that require()s React compiles to a stub that
// throws on load, and the host only logs plugin load errors to the console.
const failOnHostRequire = (): Plugin => ({
  name: 'fail-on-host-require',
  apply: 'build',
  renderChunk(code, chunk) {
    for (const id of HOST_PROVIDED) {
      if (code.includes(`__require("${id}")`)) {
        this.error(`${chunk.fileName} calls require("${id}"); alias that dependency to its ESM build`);
      }
    }
    return null;
  },
});

export default defineConfig(({ command }) => ({
  plugins: [react(), failOnHostRequire()],
  // Library mode leaves process.env untouched, but bundled MUI reads NODE_ENV.
  define:
    command === 'build'
      ? { 'process.env.NODE_ENV': JSON.stringify('production') }
      : undefined,
  build: {
    lib: {
      entry: 'src/main.tsx',
      formats: ['es'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: HOST_PROVIDED,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}));
