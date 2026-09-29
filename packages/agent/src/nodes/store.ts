import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { nodeFingerprint, parseNodeUri, type NodeProtocol } from './parser'

export interface StoredNode {
  id: string
  originalUri: string
  effectiveUri: string
  name: string
  protocol: NodeProtocol
  server: string
  port: number
  tags: string[]
  fingerprint: string
  createdAt: number
  updatedAt: number
}

export type PublicNode = Omit<
  StoredNode,
  'originalUri' | 'effectiveUri' | 'fingerprint'
> & {
  alive: boolean | null
  delay: number | null
}

export interface ProviderProxy {
  name: string
  alive?: boolean
  history?: Array<{ delay: number }>
}
export interface ProviderData {
  proxies: ProviderProxy[]
}

export interface SelectableGroup {
  name: string
  now: string
  members: string[]
}

export interface MihomoClient {
  provider: () => Promise<ProviderData>
  allProviders: () => Promise<Record<string, ProviderData>>
  reload: () => Promise<void>
  healthcheck: () => Promise<void>
  test: (name: string, url: string, timeout: number) => Promise<number>
  groups: () => Promise<SelectableGroup[]>
  select: (group: string, name: string) => Promise<void>
  version: () => Promise<boolean>
}

// Mihomo rejects PUT refreshes of empty content and `proxies: []`. A harmless
// DIRECT entry keeps the provider refreshable when the managed list is empty.
// Non-empty files contain only URIs, so formats are never mixed.
export const EMPTY_PROVIDER_CONTENT =
  'proxies:\n  - name: "Manual empty (DIRECT)"\n    type: direct\n'
const EMPTY_PROVIDER_NAME = 'Manual empty (DIRECT)'

export function createMihomoClient(base: string, secret: string): MihomoClient {
  const root = base.replace(/\/$/, '')
  async function request(
    path: string,
    method = 'GET',
    body?: Record<string, string>,
  ): Promise<Response> {
    let response: Response
    try {
      response = await fetch(`${root}${path}`, {
        method,
        headers: {
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(25_000),
      })
    } catch {
      throw new Error('MIHOMO_UNAVAILABLE')
    }
    if (!response.ok) throw new Error(`MIHOMO_HTTP_${response.status}`)
    return response
  }
  return {
    provider: async () =>
      (await (
        await request('/providers/proxies/manual')
      ).json()) as ProviderData,
    allProviders: async () => {
      const body = (await (await request('/providers/proxies')).json()) as {
        providers?: Record<string, ProviderData>
      }
      return body.providers ?? {}
    },
    reload: async () => {
      await request('/providers/proxies/manual', 'PUT')
    },
    healthcheck: async () => {
      await request('/providers/proxies/manual/healthcheck')
    },
    test: async (name, url, timeout) => {
      const query = new URLSearchParams({ url, timeout: String(timeout) })
      const body = (await (
        await request(
          `/providers/proxies/manual/${encodeURIComponent(name)}/healthcheck?${query}`,
        )
      ).json()) as { delay: number }
      return body.delay
    },
    groups: async () => {
      const body = (await (await request('/proxies')).json()) as {
        proxies?: Record<
          string,
          { name?: string; type?: string; now?: string; all?: string[] }
        >
      }
      return Object.entries(body.proxies ?? {})
        .filter(
          ([, proxy]) => proxy.type === 'Selector' && Array.isArray(proxy.all),
        )
        .map(([name, proxy]) => ({
          name,
          now: proxy.now ?? '',
          members: proxy.all ?? [],
        }))
    },
    select: async (group, name) => {
      await request(`/proxies/${encodeURIComponent(group)}`, 'PUT', { name })
    },
    version: async () => {
      try {
        await request('/version')
        return true
      } catch {
        return false
      }
    },
  }
}

async function atomicWrite(
  path: string,
  data: string | Buffer,
  mode = 0o600,
): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(data)
    await handle.chmod(mode)
    await handle.sync()
  } catch (error) {
    await handle.close()
    await rm(temp, { force: true })
    throw error
  }
  await handle.close()
  try {
    await rename(temp, path)
    const dir = await open(dirname(path), 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  } finally {
    await rm(temp, { force: true })
  }
}

function safeTags(tags: unknown): string[] {
  if (!Array.isArray(tags) || tags.length > 16) throw new Error('INVALID_TAGS')
  return [
    ...new Set(
      tags
        .map((tag) => {
          if (
            typeof tag !== 'string' ||
            tag.length > 32 ||
            /[\u0000-\u001f\u007f]/.test(tag)
          )
            throw new Error('INVALID_TAGS')
          return tag.trim()
        })
        .filter(Boolean),
    ),
  ]
}

function publicNode(node: StoredNode, live?: ProviderProxy): PublicNode {
  const {
    originalUri: _originalUri,
    effectiveUri: _effectiveUri,
    fingerprint: _fingerprint,
    ...safe
  } = node
  const delay = live?.history?.at(-1)?.delay
  return {
    ...safe,
    alive: live?.alive ?? null,
    delay: typeof delay === 'number' && delay > 0 ? delay : null,
  }
}

export function createNodeStore(
  path: string,
  mihomo: MihomoClient,
  sharedGroupRead = false,
) {
  const dir = dirname(path)
  const metaPath = join(dir, 'manual.meta.json')
  const keyPath = join(dir, 'manual.key')
  let queue: Promise<unknown> = Promise.resolve()

  async function ensurePrivateDir() {
    await mkdir(dir, { recursive: true, mode: sharedGroupRead ? 0o750 : 0o700 })
    const info = await lstat(dir)
    const directoryMode = info.mode & 0o7777
    const validMode = sharedGroupRead
      ? directoryMode === 0o2750
      : directoryMode === 0o700
    if (!info.isDirectory() || !validMode)
      throw new Error('INSECURE_PROVIDER_DIRECTORY')
  }
  async function checkPrivateFile(filePath: string) {
    let info
    try {
      info = await lstat(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const expectedMode = sharedGroupRead && filePath === path ? 0o660 : 0o600
    if (!info.isFile() || (info.mode & 0o777) !== expectedMode)
      throw new Error('INSECURE_NODE_FILE')
  }
  async function key(): Promise<Buffer> {
    await ensurePrivateDir()
    try {
      const info = await lstat(keyPath)
      if (!info.isFile() || (info.mode & 0o077) !== 0)
        throw new Error('INSECURE_NODE_KEY')
      return await readFile(keyPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const value = randomBytes(32)
      const file = await open(keyPath, 'wx', 0o600)
      try {
        await file.writeFile(value)
        await file.sync()
      } finally {
        await file.close()
      }
      return value
    }
  }
  async function readNodes(): Promise<StoredNode[]> {
    await ensurePrivateDir()
    await checkPrivateFile(path)
    await checkPrivateFile(metaPath)
    let rawMeta: string
    try {
      rawMeta = await readFile(metaPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const existing = await readFile(path, 'utf8').catch(
          (readError: NodeJS.ErrnoException) => {
            if (readError.code === 'ENOENT') return ''
            throw readError
          },
        )
        if (
          existing.trim() &&
          existing !== EMPTY_PROVIDER_CONTENT &&
          existing !== 'proxies: []\n'
        )
          throw new Error('UNMANAGED_PROVIDER_FILE')
        return []
      }
      throw error
    }
    let nodes: StoredNode[]
    try {
      nodes = JSON.parse(rawMeta) as StoredNode[]
    } catch {
      throw new Error('INVALID_NODE_METADATA')
    }
    if (!Array.isArray(nodes)) throw new Error('INVALID_NODE_METADATA')
    const expected = nodes.length
      ? `${nodes.map((node) => node.effectiveUri).join('\n')}\n`
      : EMPTY_PROVIDER_CONTENT
    const actual = await readFile(path, 'utf8').catch(() => {
      throw new Error('PROVIDER_FILE_CHANGED')
    })
    if (actual !== expected) throw new Error('PROVIDER_FILE_CHANGED')
    return nodes
  }
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const work = queue.then(fn, fn)
    queue = work.catch(() => undefined)
    return work
  }
  async function commit(next: StoredNode[]): Promise<void> {
    await ensurePrivateDir()
    const content = next.length
      ? `${next.map((node) => node.effectiveUri).join('\n')}\n`
      : EMPTY_PROVIDER_CONTENT
    const priorFile = await readFile(path).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      },
    )
    const priorMeta = await readFile(metaPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      },
    )
    await atomicWrite(`${path}.bak`, priorFile ?? '')
    if (priorMeta) await atomicWrite(`${metaPath}.bak`, priorMeta)
    try {
      await atomicWrite(path, content, sharedGroupRead ? 0o660 : 0o600)
      await mihomo.reload()
      const live = await mihomo.provider()
      const names = new Set((live.proxies ?? []).map((proxy) => proxy.name))
      if (
        next.some((node) => !names.has(node.name)) ||
        (!next.length && !names.has(EMPTY_PROVIDER_NAME))
      )
        throw new Error('PROVIDER_VERIFY_FAILED')
      await atomicWrite(metaPath, `${JSON.stringify(next)}\n`)
    } catch {
      if (priorFile)
        await atomicWrite(path, priorFile, sharedGroupRead ? 0o660 : 0o600)
      else await rm(path, { force: true })
      if (priorMeta) await atomicWrite(metaPath, priorMeta)
      else await rm(metaPath, { force: true })
      try {
        await mihomo.reload()
      } catch {
        throw new Error('PROVIDER_ROLLBACK_RELOAD_FAILED')
      }
      throw new Error('PROVIDER_UPDATE_FAILED')
    }
  }
  async function takenNames(): Promise<Set<string>> {
    const providers = await mihomo.allProviders()
    return new Set(
      Object.values(providers).flatMap((provider) =>
        (provider.proxies ?? []).map((proxy) => proxy.name),
      ),
    )
  }
  function uniqueName(name: string, taken: Set<string>): string {
    let candidate = name
    let index = 2
    while (taken.has(candidate)) candidate = `${name} (${index++})`
    taken.add(candidate)
    return candidate
  }
  async function importUris(
    uris: string[],
    tags: unknown,
  ): Promise<{ imported: PublicNode[]; duplicateCount: number }> {
    return locked(async () => {
      if (!Array.isArray(uris) || uris.length === 0 || uris.length > 200)
        throw new Error('INVALID_IMPORT')
      await mihomo.provider()
      const current = await readNodes()
      const secret = await key()
      const known = new Set(current.map((node) => node.fingerprint))
      const names = await takenNames()
      const now = Date.now()
      const added: StoredNode[] = []
      let duplicateCount = 0
      for (const uri of uris) {
        if (typeof uri !== 'string') throw new Error('INVALID_IMPORT')
        const parsed = parseNodeUri(uri.trim())
        const fingerprint = nodeFingerprint(parsed, secret)
        if (known.has(fingerprint)) {
          duplicateCount++
          continue
        }
        known.add(fingerprint)
        const name = uniqueName(parsed.name, names)
        added.push({
          id: randomUUID(),
          originalUri: uri.trim(),
          effectiveUri: parsed.withName(name),
          name,
          protocol: parsed.protocol,
          server: parsed.server,
          port: parsed.port,
          tags: safeTags(tags),
          fingerprint,
          createdAt: now,
          updatedAt: now,
        })
      }
      if (added.length) await commit([...current, ...added])
      return { imported: added.map((node) => publicNode(node)), duplicateCount }
    })
  }
  async function update(
    id: string,
    patch: { uri?: string; name?: string; tags?: unknown; revision?: number },
  ): Promise<PublicNode> {
    return locked(async () => {
      const current = await readNodes()
      const index = current.findIndex((node) => node.id === id)
      if (index < 0) throw new Error('NODE_NOT_FOUND')
      const old = current[index]!
      if (patch.revision !== undefined && patch.revision !== old.updatedAt)
        throw new Error('NODE_CONFLICT')
      const originalUri =
        patch.uri === undefined ? old.originalUri : patch.uri.trim()
      const parsed = parseNodeUri(originalUri)
      const fingerprint = nodeFingerprint(parsed, await key())
      if (
        current.some(
          (node) => node.id !== id && node.fingerprint === fingerprint,
        )
      )
        throw new Error('DUPLICATE_NODE')
      const names = await takenNames()
      const requestedName = patch.name?.trim() || parsed.name
      const name =
        requestedName === old.name ? old.name : uniqueName(requestedName, names)
      const node: StoredNode = {
        ...old,
        originalUri,
        effectiveUri: parsed.withName(name),
        name,
        protocol: parsed.protocol,
        server: parsed.server,
        port: parsed.port,
        fingerprint,
        tags: patch.tags === undefined ? old.tags : safeTags(patch.tags),
        updatedAt: Date.now(),
      }
      current[index] = node
      await commit(current)
      return publicNode(node)
    })
  }
  async function remove(id: string): Promise<void> {
    return locked(async () => {
      const current = await readNodes()
      if (!current.some((node) => node.id === id))
        throw new Error('NODE_NOT_FOUND')
      await commit(current.filter((node) => node.id !== id))
    })
  }
  async function removeMany(ids: string[]): Promise<number> {
    return locked(async () => {
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > 200 ||
        ids.some((id) => typeof id !== 'string')
      )
        throw new Error('INVALID_NODE_SELECTION')
      const selected = new Set(ids)
      const current = await readNodes()
      if (
        selected.size !== ids.length ||
        current.filter((node) => selected.has(node.id)).length !== selected.size
      )
        throw new Error('NODE_NOT_FOUND')
      await commit(current.filter((node) => !selected.has(node.id)))
      return selected.size
    })
  }
  return {
    preview: async (text: string) => {
      const uris = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      if (uris.length > 200 || text.length > 2_000_000)
        throw new Error('INVALID_IMPORT')
      const current = await readNodes()
      const secret = await key()
      const known = new Set(current.map((node) => node.fingerprint))
      return uris.map((uri, index) => {
        try {
          const parsed = parseNodeUri(uri)
          const fingerprint = nodeFingerprint(parsed, secret)
          const duplicate = known.has(fingerprint)
          known.add(fingerprint)
          return {
            index,
            valid: true,
            protocol: parsed.protocol,
            name: parsed.name,
            server: parsed.server,
            port: parsed.port,
            duplicate,
          }
        } catch (error) {
          return {
            index,
            valid: false,
            error:
              error instanceof Error &&
              error.message === 'UNSUPPORTED_NODE_PROTOCOL'
                ? 'UNSUPPORTED_NODE_PROTOCOL'
                : 'INVALID_NODE_URI',
          }
        }
      })
    },
    list: async () => {
      const [nodes, provider] = await Promise.all([
        readNodes(),
        mihomo.provider(),
      ])
      const live = new Map(
        (provider.proxies ?? []).map((proxy) => [proxy.name, proxy]),
      )
      return nodes.map((node) => publicNode(node, live.get(node.name)))
    },
    reveal: async (id: string) => {
      const node = (await readNodes()).find((item) => item.id === id)
      if (!node) throw new Error('NODE_NOT_FOUND')
      return node.originalUri
    },
    importUris,
    update,
    remove,
    removeMany,
    groups: async (): Promise<SelectableGroup[]> => {
      const [current, groups] = await Promise.all([
        readNodes(),
        mihomo.groups(),
      ])
      const names = new Set(current.map((node) => node.name))
      return groups
        .map((group) => ({
          name: group.name,
          now: group.now,
          members: group.members.filter((name) => names.has(name)),
        }))
        .filter((group) => group.members.length > 0)
    },
    select: async (id: string, groupName: string) => {
      const current = await readNodes()
      const node = current.find((item) => item.id === id)
      if (!node) throw new Error('NODE_NOT_FOUND')
      const group = (await mihomo.groups()).find(
        (item) => item.name === groupName && item.members.includes(node.name),
      )
      if (!group) throw new Error('GROUP_NOT_FOUND')
      await mihomo.select(groupName, node.name)
      return { group: groupName, name: node.name }
    },
    reload: async () => {
      await mihomo.reload()
      return mihomo.provider()
    },
    healthcheck: () => mihomo.healthcheck(),
    test: async (id: string, url: string, timeout: number) => {
      const node = (await readNodes()).find((item) => item.id === id)
      if (!node) throw new Error('NODE_NOT_FOUND')
      return mihomo.test(node.name, url, timeout)
    },
    status: async () => {
      const mihomoReachable = await mihomo.version()
      let providerReady = false
      try {
        await mihomo.provider()
        providerReady = true
      } catch {
        /* setup incomplete */
      }
      let storageReady = false
      try {
        await readNodes()
        storageReady = true
      } catch {
        /* setup incomplete */
      }
      return {
        mihomoReachable,
        providerReady,
        storageReady,
        providerPath: path,
      }
    },
  }
}
