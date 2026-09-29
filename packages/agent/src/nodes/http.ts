import type { H3Event } from 'h3'
import {
  createApp,
  createError,
  createRouter,
  defineEventHandler,
  getHeader,
  getRouterParam,
  readBody,
  setHeader,
} from 'h3'
import { createMihomoClient, createNodeStore } from './store'

export interface ExternalNodeAgentOptions {
  providerPath: string
  sharedGroupRead?: boolean
  mihomoApiUrl: string
  mihomoSecret: string
  controlToken: string
}

function statusFor(code: string): number {
  if (code === 'NODE_NOT_FOUND' || code === 'GROUP_NOT_FOUND') return 404
  if (code === 'NODE_CONFLICT' || code === 'DUPLICATE_NODE') return 409
  if (code === 'MIHOMO_UNAVAILABLE' || code.startsWith('MIHOMO_HTTP_'))
    return 503
  if (
    code === 'PROVIDER_UPDATE_FAILED' ||
    code === 'PROVIDER_VERIFY_FAILED' ||
    code === 'PROVIDER_ROLLBACK_RELOAD_FAILED'
  )
    return 502
  return 400
}

function safe<T>(action: (event: H3Event) => Promise<T>) {
  return defineEventHandler(async (event) => {
    try {
      return await action(event)
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z][A-Z0-9_]*$/.test(error.message)
          ? error.message
          : 'NODE_OPERATION_FAILED'
      throw createError({ statusCode: statusFor(code), statusMessage: code })
    }
  })
}

export function createExternalNodeAgent(opts: ExternalNodeAgentOptions) {
  const app = createApp()
  const router = createRouter()
  const mihomo = createMihomoClient(opts.mihomoApiUrl, opts.mihomoSecret)
  const nodes = createNodeStore(
    opts.providerPath,
    mihomo,
    opts.sharedGroupRead ?? false,
  )
  const info = () => ({
    hasAgent: true as const,
    version: '0.0.0',
    platform: { os: process.platform, arch: process.arch },
    kernel: { bundled: false, path: '' },
    features: ['nodes'],
  })

  app.use(
    defineEventHandler((event) => {
      const path = event.path.split('?')[0]
      if (!path?.startsWith('/api/control/')) return
      if (path === '/api/control/health' || path === '/api/control/info') return
      if (!opts.controlToken)
        throw createError({
          statusCode: 503,
          statusMessage: 'CONTROL_TOKEN_REQUIRED',
        })
      if (getHeader(event, 'authorization') !== `Bearer ${opts.controlToken}`)
        throw createError({ statusCode: 401, statusMessage: 'UNAUTHORIZED' })
      setHeader(event, 'cache-control', 'no-store')
    }),
  )
  router.get(
    '/api/control/health',
    defineEventHandler(() => ({ ok: true })),
  )
  router.get('/api/control/info', defineEventHandler(info))
  router.get(
    '/api/control/nodes',
    safe(() => nodes.list()),
  )
  router.post(
    '/api/control/nodes/preview',
    safe(async (event) => {
      const body = await readBody<{ text?: unknown }>(event)
      if (typeof body?.text !== 'string') throw new Error('INVALID_IMPORT')
      return { items: await nodes.preview(body.text) }
    }),
  )
  router.post(
    '/api/control/nodes/import',
    safe(async (event) => {
      const body = await readBody<{ uris?: unknown; tags?: unknown }>(event)
      if (!Array.isArray(body?.uris)) throw new Error('INVALID_IMPORT')
      return nodes.importUris(body.uris, body.tags ?? [])
    }),
  )
  router.get(
    '/api/control/nodes/groups',
    safe(() => nodes.groups()),
  )
  router.post(
    '/api/control/nodes/select',
    safe(async (event) => {
      const body = await readBody<{ id?: unknown; group?: unknown }>(event)
      if (typeof body?.id !== 'string' || typeof body.group !== 'string')
        throw new Error('INVALID_NODE_SELECTION')
      return nodes.select(body.id, body.group)
    }),
  )
  router.post(
    '/api/control/nodes/delete',
    safe(async (event) => {
      const body = await readBody<{ ids?: unknown }>(event)
      if (!Array.isArray(body?.ids)) throw new Error('INVALID_NODE_SELECTION')
      return { deleted: await nodes.removeMany(body.ids) }
    }),
  )
  router.get(
    '/api/control/nodes/:id/uri',
    safe(async (event) => ({
      uri: await nodes.reveal(getRouterParam(event, 'id') ?? ''),
    })),
  )
  router.put(
    '/api/control/nodes/:id',
    safe(async (event) => {
      const body = await readBody<{
        uri?: string
        name?: string
        tags?: unknown
        revision?: number
      }>(event)
      if (!body || typeof body !== 'object')
        throw new Error('INVALID_NODE_UPDATE')
      return nodes.update(getRouterParam(event, 'id') ?? '', body)
    }),
  )
  router.delete(
    '/api/control/nodes/:id',
    safe(async (event) => {
      await nodes.remove(getRouterParam(event, 'id') ?? '')
      return { ok: true }
    }),
  )
  router.post(
    '/api/control/nodes/test',
    safe(async (event) => {
      const body = await readBody<{
        id?: unknown
        url?: unknown
        timeout?: unknown
      }>(event)
      if (typeof body?.id !== 'string') throw new Error('INVALID_NODE_TEST')
      const url =
        typeof body.url === 'string'
          ? body.url
          : 'https://www.gstatic.com/generate_204'
      const timeout = typeof body.timeout === 'number' ? body.timeout : 5000
      if (
        !/^https?:\/\//.test(url) ||
        url.length > 2048 ||
        !Number.isInteger(timeout) ||
        timeout < 1000 ||
        timeout > 30_000
      )
        throw new Error('INVALID_NODE_TEST')
      return { delay: await nodes.test(body.id, url, timeout) }
    }),
  )
  router.post(
    '/api/control/providers/manual/reload',
    safe(async () => {
      const provider = await nodes.reload()
      return { ok: true, count: provider.proxies?.length ?? 0 }
    }),
  )
  router.post(
    '/api/control/providers/manual/healthcheck',
    safe(async () => {
      await nodes.healthcheck()
      return { ok: true }
    }),
  )
  router.get(
    '/api/control/system/status',
    safe(() => nodes.status()),
  )
  app.use(router)
  return { router: app, info, nodes }
}
