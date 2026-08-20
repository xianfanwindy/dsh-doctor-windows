import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/plugin.ts'],
  format: ['esm'],
  target: 'es2024',
  dts: true,
})
