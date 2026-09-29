import { defineNitroConfig } from 'nitropack/config'

export default defineNitroConfig({
  preset: 'node-server',
  // Pin so Nitro feature flags do not drift between builds.
  compatibilityDate: '2025-01-01',
  // The catch-all route serves UI_DIST at runtime. Bundling generated UI files
  // here lets the static /config.js shadow the dynamic token-injecting route.
  publicAssets: [],
  // Exclude test files from Nitro's middleware/routes scanner.
  ignore: ['**/__tests__/**', '**/*.spec.ts', '**/*.test.ts'],
  // NOTE: Intentionally NO Clash-API proxy here. Nitro routeRules `proxy`
  // cannot upgrade WebSocket connections (nitrojs/nitro#2886), and the
  // dashboard talks to mihomo's Clash API over native WebSocket (traffic,
  // connections, logs). Proxying would yield a half-broken endpoint (HTTP ok,
  // WS dead). Instead the agent injects `external-controller: 0.0.0.0:<port>`
  // into the active config and the published 9090 port is hit directly by the
  // UI endpoint store. Do NOT add a /clash-api proxy route.
})
