import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@agentbus/protocol': pkg('protocol'),
      '@agentbus/core': pkg('core'),
      '@agentbus/a2a': pkg('a2a'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'e2e/**/*.test.ts'],
    testTimeout: 20_000,
  },
})
