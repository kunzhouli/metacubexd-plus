import { join } from 'node:path'
import { createAgent, createExternalNodeAgent } from '@metacubexd/agent'

/** Parsed server runtime config, sourced entirely from env. */
export interface ServerEnv {
  mihomoMode: 'bundled' | 'external'
  mihomoHome: string
  mihomoApiUrl: string
  manualProviderSharedGroup: boolean
  controlPort: number
  clashApiPort: number
  mixedPort: number
  dataDir: string
  mihomoBin: string
  controlToken: string
  clashSecret: string
  githubToken: string
  defaultBackendURL: string
}

function int(value: string | undefined, fallback: number): number {
  const n = value == null ? Number.NaN : Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

/** Read process.env into a typed ServerEnv with documented defaults. */
export function serverEnv(): ServerEnv {
  return {
    mihomoMode: process.env.MIHOMO_MODE === 'external' ? 'external' : 'bundled',
    mihomoHome: process.env.MIHOMO_HOME ?? '/etc/mihomo',
    mihomoApiUrl: process.env.MIHOMO_API_URL ?? 'http://127.0.0.1:9090',
    manualProviderSharedGroup: process.env.MANUAL_PROVIDER_SHARED_GROUP === '1',
    controlPort: int(process.env.CONTROL_PORT, 8080),
    clashApiPort: int(process.env.CLASH_API_PORT, 9090),
    mixedPort: int(process.env.MIXED_PORT, 7890),
    dataDir: process.env.DATA_DIR ?? '/data',
    mihomoBin: process.env.MIHOMO_BIN ?? '/usr/local/bin/mihomo',
    controlToken: process.env.CONTROL_TOKEN ?? '',
    clashSecret: process.env.CLASH_SECRET ?? '',
    githubToken: process.env.GITHUB_TOKEN ?? '',
    defaultBackendURL: process.env.DEFAULT_BACKEND_URL ?? '',
  }
}

export type Agent =
  ReturnType<typeof createAgent> | ReturnType<typeof createExternalNodeAgent>

let agentSingleton: Agent | undefined

/**
 * Module-singleton agent. Built once per process from serverEnv():
 * homeDir/profilesDir/activeConfigPath live under DATA_DIR; the kernel binary
 * is MIHOMO_BIN; agentToken comes from CONTROL_TOKEN (empty => unauthenticated,
 * which the auth middleware treats as "no token configured").
 */
export function getAgent(): Agent {
  if (agentSingleton) return agentSingleton
  const env = serverEnv()
  if (env.mihomoMode === 'external') {
    agentSingleton = createExternalNodeAgent({
      providerPath: join(env.mihomoHome, 'proxy_providers', 'manual.txt'),
      sharedGroupRead: env.manualProviderSharedGroup,
      mihomoApiUrl: env.mihomoApiUrl,
      mihomoSecret: env.clashSecret,
      controlToken: env.controlToken,
    })
    return agentSingleton
  }
  return getManagedAgent()
}

export function getManagedAgent(): ReturnType<typeof createAgent> {
  if (agentSingleton && 'supervisor' in agentSingleton) return agentSingleton
  const env = serverEnv()
  agentSingleton = createAgent({
    binaryPath: env.mihomoBin,
    homeDir: env.dataDir,
    profilesDir: join(env.dataDir, 'profiles'),
    activeConfigPath: join(env.dataDir, 'active.yaml'),
    agentToken: env.controlToken || undefined,
    // The agent's supervisor injects these into the active config before
    // spawning mihomo (per Plan 02). external-controller must bind 0.0.0.0 so
    // the published container port is reachable; secret is CLASH_SECRET.
    externalController: `0.0.0.0:${env.clashApiPort}`,
    secret: env.clashSecret,
    // Inject mixed-port too, otherwise MIXED_PORT is dead env: the supervisor
    // strips any profile mixed-port on spawn and, without a managed value, never
    // re-adds one, so the published proxy port (7890) stays closed (#2067).
    mixedPort: env.mixedPort,
  })
  return agentSingleton
}

/** Test-only reset hook. */
export function __resetAgentForTests(): void {
  agentSingleton = undefined
}
