import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Artifact smoke tests intentionally rebuild the shared lib directory.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      exclude: ['**/*.d.ts', 'src/plugin.ts'],
      thresholds: {
        lines: 95,
        functions: 95,
        statements: 95,
        branches: 95,
      },
    },
  },
})
