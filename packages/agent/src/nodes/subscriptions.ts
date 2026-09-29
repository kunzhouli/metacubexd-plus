import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { parseNodeUri } from './parser'
import { atomicWrite, type MihomoClient } from './store'

export const SUBSCRIPTION_PROVIDERS = {
  uri: 'subscriptions-uri',
  yaml: 'subscriptions-yaml',
} as const

const EMPTY_URI =
  'proxies:\n  - name: "Subscriptions URI empty (DIRECT)"\n    type: direct\n'
const EMPTY_YAML =
  'proxies:\n  - name: "Subscriptions YAML empty (DIRECT)"\n    type: direct\n'
const MAX_SOURCES = 30
const MAX_BODY = 2_000_000
const MAX_NODES = 2000

type SubscriptionFormat = 'uri' | 'yaml'
type YamlProxy = Record<string, unknown> & { name: string; type: string }
type CachedNode = {
  uri?: string
  proxy?: YamlProxy
  fingerprint: string
  name: string
  protocol: string
  server: string
  port: number
}

interface Subscription {
  id: string
  name: string
  url: string
  format: SubscriptionFormat
  intervalHours: number
  createdAt: number
  updatedAt: number
  lastUpdatedAt: number
  lastError: string | null
  nodes: CachedNode[]
}

function safeUrl(input: unknown): URL {
  if (typeof input !== 'string' || input.length > 4096)
    throw new Error('INVALID_SUBSCRIPTION_URL')
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('INVALID_SUBSCRIPTION_URL')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('INVALID_SUBSCRIPTION_URL')
  if (
    url.hostname.toLowerCase() === 'localhost' ||
    url.hostname.startsWith('127.') ||
    url.hostname.startsWith('169.254.') ||
    ['::1', '[::1]'].includes(url.hostname)
  )
    throw new Error('INVALID_SUBSCRIPTION_URL')
  return url
}

function safeName(input: unknown): string {
  if (typeof input !== 'string') throw new Error('INVALID_SUBSCRIPTION_NAME')
  const name = input.trim()
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name))
    throw new Error('INVALID_SUBSCRIPTION_NAME')
  return name
}

function safeInterval(input: unknown): number {
  const value = input === undefined ? 24 : input
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 720
  )
    throw new Error('INVALID_SUBSCRIPTION_INTERVAL')
  return value
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function publicSubscription(source: Subscription) {
  const { url: _url, nodes, ...safe } = source
  return { ...safe, host: new URL(source.url).host, count: nodes.length }
}

async function fetchText(input: string): Promise<string> {
  let url = safeUrl(input)
  for (let redirects = 0; redirects <= 3; redirects++) {
    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          'User-Agent': 'mihomo/1.0',
          Accept: 'text/plain, application/yaml, */*',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      })
    } catch {
      throw new Error('SUBSCRIPTION_FETCH_FAILED')
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new Error('SUBSCRIPTION_FETCH_FAILED')
      url = safeUrl(new URL(location, url).toString())
      continue
    }
    if (!response.ok || !response.body)
      throw new Error('SUBSCRIPTION_FETCH_FAILED')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BODY) throw new Error('SUBSCRIPTION_TOO_LARGE')
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .trim()
  }
  throw new Error('SUBSCRIPTION_FETCH_FAILED')
}

function parseContent(body: string): {
  format: SubscriptionFormat
  nodes: CachedNode[]
} {
  if (!body) throw new Error('INVALID_SUBSCRIPTION_CONTENT')
  if (/^\s*(?:proxies|proxy-providers):/m.test(body)) {
    let doc: unknown
    try {
      doc = parse(body)
    } catch {
      throw new Error('INVALID_SUBSCRIPTION_CONTENT')
    }
    const proxies = (doc as { proxies?: unknown } | null)?.proxies
    if (
      !Array.isArray(proxies) ||
      !proxies.length ||
      proxies.length > MAX_NODES
    )
      throw new Error('INVALID_SUBSCRIPTION_CONTENT')
    const nodes = proxies.map((item): CachedNode => {
      if (!item || typeof item !== 'object')
        throw new Error('INVALID_SUBSCRIPTION_CONTENT')
      const proxy = item as YamlProxy
      const name = safeName(proxy.name)
      if (
        typeof proxy.type !== 'string' ||
        !proxy.type ||
        typeof proxy.server !== 'string' ||
        !proxy.server ||
        !Number.isInteger(proxy.port) ||
        Number(proxy.port) < 1 ||
        Number(proxy.port) > 65535
      )
        throw new Error('INVALID_SUBSCRIPTION_CONTENT')
      const { name: _name, ...identity } = proxy
      return {
        proxy,
        name,
        protocol: proxy.type,
        server: proxy.server,
        port: Number(proxy.port),
        fingerprint: fingerprint(identity),
      }
    })
    return { format: 'yaml', nodes }
  }
  let text = body
  if (!/^[a-z][a-z0-9+.-]*:\/\//im.test(text)) {
    try {
      text = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8')
    } catch {
      throw new Error('INVALID_SUBSCRIPTION_CONTENT')
    }
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  if (!lines.length || lines.length > MAX_NODES)
    throw new Error('INVALID_SUBSCRIPTION_CONTENT')
  const nodes = lines.map((uri): CachedNode => {
    let parsed
    try {
      parsed = parseNodeUri(uri)
    } catch {
      throw new Error('INVALID_SUBSCRIPTION_CONTENT')
    }
    return {
      uri,
      name: parsed.name,
      protocol: parsed.protocol,
      server: parsed.server,
      port: parsed.port,
      fingerprint: fingerprint(parsed.identity),
    }
  })
  return { format: 'uri', nodes }
}

export function createSubscriptionStore(
  providerDir: string,
  mihomo: MihomoClient,
  sharedGroupRead = false,
  fetchSubscription = fetchText,
) {
  const metaPath = join(providerDir, 'subscriptions.meta.json')
  const uriPath = join(providerDir, 'subscriptions-uri.txt')
  const yamlPath = join(providerDir, 'subscriptions-yaml.yaml')
  const providerMode = sharedGroupRead ? 0o660 : 0o600
  let queue: Promise<unknown> = Promise.resolve()
  function locked<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
  async function checkFile(path: string, mode: number) {
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || (stat.mode & 0o777) !== mode)
        throw new Error('INSECURE_SUBSCRIPTION_FILE')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  async function read(): Promise<Subscription[]> {
    const dir = await lstat(providerDir)
    if (
      !dir.isDirectory() ||
      (dir.mode & 0o7777) !== (sharedGroupRead ? 0o2750 : 0o700)
    )
      throw new Error('INSECURE_PROVIDER_DIRECTORY')
    await checkFile(metaPath, 0o600)
    let body: string
    try {
      body = await readFile(metaPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    try {
      const sources = JSON.parse(body) as Subscription[]
      if (
        !Array.isArray(sources) ||
        sources.length > MAX_SOURCES ||
        sources.some(
          (s) =>
            !s ||
            typeof s.id !== 'string' ||
            typeof s.url !== 'string' ||
            !Array.isArray(s.nodes),
        )
      )
        throw new Error('INVALID_SUBSCRIPTION_METADATA')
      return sources
    } catch {
      throw new Error('INVALID_SUBSCRIPTION_METADATA')
    }
  }
  async function render(sources: Subscription[]) {
    const providers = await mihomo.allProviders()
    const taken = new Set(
      Object.entries(providers)
        .filter(
          ([name]) =>
            !Object.values(SUBSCRIPTION_PROVIDERS).includes(
              name as (typeof SUBSCRIPTION_PROVIDERS)[keyof typeof SUBSCRIPTION_PROVIDERS],
            ),
        )
        .flatMap(
          ([, provider]) => provider.proxies?.map((proxy) => proxy.name) ?? [],
        ),
    )
    const seen = new Set<string>()
    const uris: string[] = []
    const yaml: YamlProxy[] = []
    for (const source of sources)
      for (const node of source.nodes) {
        if (seen.has(node.fingerprint)) continue
        seen.add(node.fingerprint)
        let name = node.name
        for (let n = 2; taken.has(name); n++) name = `${node.name} (${n})`
        taken.add(name)
        if (source.format === 'uri' && node.uri)
          uris.push(parseNodeUri(node.uri).withName(name))
        if (source.format === 'yaml' && node.proxy)
          yaml.push({ ...node.proxy, name })
      }
    return {
      uri: uris.length ? `${uris.join('\n')}\n` : EMPTY_URI,
      yaml: yaml.length ? stringify({ proxies: yaml }) : EMPTY_YAML,
      uriNames: uris.map((uri) => parseNodeUri(uri).name),
      yamlNames: yaml.map((proxy) => proxy.name),
    }
  }
  async function commit(next: Subscription[]) {
    const generated = await render(next)
    await Promise.all(
      [
        [uriPath, providerMode],
        [yamlPath, providerMode],
        [metaPath, 0o600],
      ].map(([path, mode]) => checkFile(path as string, mode as number)),
    )
    const old = await Promise.all(
      [uriPath, yamlPath, metaPath].map(async (path) =>
        readFile(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        }),
      ),
    )
    await Promise.all(
      [uriPath, yamlPath, metaPath].map((path, index) =>
        atomicWrite(`${path}.bak`, old[index] ?? '', 0o600),
      ),
    )
    try {
      await atomicWrite(uriPath, generated.uri, providerMode)
      await atomicWrite(yamlPath, generated.yaml, providerMode)
      for (const [format, names] of [
        ['uri', generated.uriNames],
        ['yaml', generated.yamlNames],
      ] as const) {
        const name = SUBSCRIPTION_PROVIDERS[format]
        await mihomo.reloadNamed(name)
        const live = await mihomo.namedProvider(name)
        const loaded = new Set(live.proxies?.map((proxy) => proxy.name) ?? [])
        if (names.some((nodeName) => !loaded.has(nodeName)))
          throw new Error('PROVIDER_VERIFY_FAILED')
      }
      await atomicWrite(metaPath, `${JSON.stringify(next)}\n`)
    } catch {
      for (const [index, path] of [uriPath, yamlPath, metaPath].entries()) {
        if (old[index])
          await atomicWrite(
            path,
            old[index],
            index === 2 ? 0o600 : providerMode,
          )
        else await rm(path, { force: true })
      }
      try {
        await Promise.all(
          Object.values(SUBSCRIPTION_PROVIDERS).map((name) =>
            mihomo.reloadNamed(name),
          ),
        )
      } catch {
        throw new Error('PROVIDER_ROLLBACK_RELOAD_FAILED')
      }
      throw new Error('PROVIDER_UPDATE_FAILED')
    }
  }
  async function refreshed(source: Subscription): Promise<Subscription> {
    const parsed = parseContent(await fetchSubscription(source.url))
    return {
      ...source,
      ...parsed,
      lastUpdatedAt: Date.now(),
      lastError: null,
      updatedAt: Date.now(),
    }
  }
  return {
    list: async () => (await read()).map(publicSubscription),
    reveal: async (id: string) => {
      const source = (await read()).find((item) => item.id === id)
      if (!source) throw new Error('SUBSCRIPTION_NOT_FOUND')
      return source.url
    },
    preview: async (url: string) => {
      const parsed = parseContent(await fetchSubscription(url))
      return {
        format: parsed.format,
        count: parsed.nodes.length,
        items: parsed.nodes
          .slice(0, 20)
          .map(({ name, protocol, server, port }) => ({
            name,
            protocol,
            server,
            port,
          })),
      }
    },
    add: (body: { name?: unknown; url?: unknown; intervalHours?: unknown }) =>
      locked(async () => {
        const sources = await read()
        if (sources.length >= MAX_SOURCES) throw new Error('SUBSCRIPTION_LIMIT')
        const url = safeUrl(body.url).toString()
        if (sources.some((item) => item.url === url))
          throw new Error('DUPLICATE_SUBSCRIPTION')
        const now = Date.now()
        const source = await refreshed({
          id: randomUUID(),
          name: safeName(body.name),
          url,
          format: 'uri',
          intervalHours: safeInterval(body.intervalHours),
          createdAt: now,
          updatedAt: now,
          lastUpdatedAt: 0,
          lastError: null,
          nodes: [],
        })
        await commit([...sources, source])
        return publicSubscription(source)
      }),
    update: (
      id: string,
      body: { name?: unknown; url?: unknown; intervalHours?: unknown },
    ) =>
      locked(async () => {
        const sources = await read()
        const index = sources.findIndex((item) => item.id === id)
        if (index < 0) throw new Error('SUBSCRIPTION_NOT_FOUND')
        const previous = sources[index]!
        const url =
          body.url === undefined ? previous.url : safeUrl(body.url).toString()
        if (sources.some((item) => item.id !== id && item.url === url))
          throw new Error('DUPLICATE_SUBSCRIPTION')
        let next = {
          ...previous,
          url,
          name: body.name === undefined ? previous.name : safeName(body.name),
          intervalHours:
            body.intervalHours === undefined
              ? previous.intervalHours
              : safeInterval(body.intervalHours),
          updatedAt: Date.now(),
        }
        if (url !== previous.url) next = await refreshed(next)
        sources[index] = next
        await commit(sources)
        return publicSubscription(next)
      }),
    remove: (id: string) =>
      locked(async () => {
        const sources = await read()
        if (!sources.some((item) => item.id === id))
          throw new Error('SUBSCRIPTION_NOT_FOUND')
        await commit(sources.filter((item) => item.id !== id))
      }),
    refresh: (id: string) =>
      locked(async () => {
        const sources = await read()
        const index = sources.findIndex((item) => item.id === id)
        if (index < 0) throw new Error('SUBSCRIPTION_NOT_FOUND')
        const next = await refreshed(sources[index]!)
        sources[index] = next
        await commit(sources)
        return publicSubscription(next)
      }),
    refreshDue: () =>
      locked(async () => {
        const sources = await read()
        for (let index = 0; index < sources.length; index++) {
          const source = sources[index]!
          if (
            !source.intervalHours ||
            Date.now() -
              (source.lastError ? source.updatedAt : source.lastUpdatedAt) <
              source.intervalHours * 3_600_000
          )
            continue
          try {
            const updated = await refreshed(source)
            const next = [...sources]
            next[index] = updated
            await commit(next)
            sources[index] = updated
          } catch {
            source.lastError = 'SUBSCRIPTION_REFRESH_FAILED'
            source.updatedAt = Date.now()
            await atomicWrite(metaPath, `${JSON.stringify(sources)}\n`)
          }
        }
      }),
    healthcheck: async () =>
      Promise.all(
        Object.values(SUBSCRIPTION_PROVIDERS).map((name) =>
          mihomo.healthcheckNamed(name),
        ),
      ),
    status: async () => {
      const names = await Promise.all(
        Object.values(SUBSCRIPTION_PROVIDERS).map((name) =>
          mihomo
            .namedProvider(name)
            .then(() => true)
            .catch(() => false),
        ),
      )
      return {
        providerReady: names.every(Boolean),
        count: (await read()).length,
      }
    },
  }
}
