import { createHmac } from 'node:crypto'

export type NodeProtocol =
  'ss' | 'vmess' | 'vless' | 'trojan' | 'hysteria2' | 'tuic' | 'anytls'

export interface ParsedNode {
  protocol: NodeProtocol
  name: string
  server: string
  port: number
  identity: string
  withName: (name: string) => string
}

interface Adapter {
  schemes: string[]
  parse: (uri: string) => ParsedNode
}

function fail(): never {
  throw new Error('INVALID_NODE_URI')
}

function cleanName(value: string): string {
  const name = value.trim().replace(/[\u0000-\u001f\u007f]/g, '')
  return name.slice(0, 128) || 'Node'
}

function portOf(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail()
  return port
}

function decodeBase64(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1)
    fail()
  return Buffer.from(normalized, 'base64').toString('utf8')
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sorted(v)]),
    )
  }
  return value
}

function urlAdapter(
  protocol: NodeProtocol,
  schemes: string[] = [protocol],
): Adapter {
  return {
    schemes,
    parse(uri) {
      let url: URL
      try {
        url = new URL(uri)
      } catch {
        fail()
      }
      if (!url.hostname || !url.port || !url.username) fail()
      const port = portOf(url.port)
      const hashAt = uri.indexOf('#')
      const base = hashAt < 0 ? uri : uri.slice(0, hashAt)
      const name = cleanName(
        url.hash
          ? decodeURIComponent(url.hash.slice(1))
          : `${protocol}-${url.hostname}`,
      )
      const query = [...url.searchParams.entries()].sort(
        ([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv),
      )
      const identity = JSON.stringify([
        protocol,
        url.hostname.toLowerCase(),
        port,
        decodeURIComponent(url.username),
        decodeURIComponent(url.password),
        query,
      ])
      return {
        protocol,
        name,
        server: url.hostname,
        port,
        identity,
        withName: (next) => `${base}#${encodeURIComponent(cleanName(next))}`,
      }
    },
  }
}

const ssAdapter: Adapter = {
  schemes: ['ss'],
  parse(uri) {
    const body = uri.slice(5)
    const hashAt = body.indexOf('#')
    const withoutHash = hashAt < 0 ? body : body.slice(0, hashAt)
    const queryAt = withoutHash.indexOf('?')
    const withoutQuery =
      queryAt < 0 ? withoutHash : withoutHash.slice(0, queryAt)
    let decoded = withoutQuery
    if (!decoded.includes('@')) decoded = decodeBase64(decoded)
    else {
      const at = decoded.lastIndexOf('@')
      const user = decoded.slice(0, at)
      if (!user.includes(':'))
        decoded = `${decodeBase64(user)}@${decoded.slice(at + 1)}`
    }
    const at = decoded.lastIndexOf('@')
    if (at < 1) fail()
    const auth = decoded.slice(0, at)
    const hostPort = decoded.slice(at + 1)
    const colon = hostPort.lastIndexOf(':')
    if (!auth.includes(':') || colon < 1) fail()
    const server = hostPort
      .slice(0, colon)
      .replace(/^\[/, '')
      .replace(/\]$/, '')
    const port = portOf(hostPort.slice(colon + 1))
    if (!server) fail()
    const query = queryAt < 0 ? '' : withoutHash.slice(queryAt + 1)
    const name = cleanName(
      hashAt < 0 ? `ss-${server}` : decodeURIComponent(body.slice(hashAt + 1)),
    )
    const identity = JSON.stringify([
      'ss',
      server.toLowerCase(),
      port,
      auth,
      [...new URLSearchParams(query).entries()].sort(),
    ])
    return {
      protocol: 'ss',
      name,
      server,
      port,
      identity,
      withName: (next) =>
        `ss://${withoutHash}#${encodeURIComponent(cleanName(next))}`,
    }
  },
}

const vmessAdapter: Adapter = {
  schemes: ['vmess'],
  parse(uri) {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(decodeBase64(uri.slice(8))) as Record<string, unknown>
    } catch {
      fail()
    }
    if (
      !obj ||
      typeof obj !== 'object' ||
      typeof obj.add !== 'string' ||
      typeof obj.id !== 'string'
    )
      fail()
    const server = obj.add.trim()
    const port = portOf(String(obj.port ?? ''))
    if (!server || !obj.id) fail()
    const name = cleanName(
      typeof obj.ps === 'string' ? obj.ps : `vmess-${server}`,
    )
    const { ps: _ps, ...other } = obj
    const identity = JSON.stringify(sorted(other))
    return {
      protocol: 'vmess',
      name,
      server,
      port,
      identity,
      withName: (next) =>
        `vmess://${Buffer.from(JSON.stringify({ ...obj, ps: cleanName(next) })).toString('base64')}`,
    }
  },
}

const adapters: Adapter[] = [
  ssAdapter,
  vmessAdapter,
  urlAdapter('vless'),
  urlAdapter('trojan'),
  urlAdapter('hysteria2', ['hysteria2', 'hy2']),
  urlAdapter('tuic'),
  urlAdapter('anytls'),
]
const registry = new Map(
  adapters.flatMap((adapter) =>
    adapter.schemes.map((scheme) => [scheme, adapter] as const),
  ),
)

export function parseNodeUri(uri: string): ParsedNode {
  if (!uri || uri.length > 16_384 || /[\r\n\u0000]/.test(uri)) fail()
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(uri)?.[1]?.toLowerCase()
  const adapter = scheme ? registry.get(scheme) : undefined
  if (!adapter) throw new Error('UNSUPPORTED_NODE_PROTOCOL')
  try {
    return adapter.parse(uri)
  } catch {
    fail()
  }
}

export function nodeFingerprint(parsed: ParsedNode, key: Buffer): string {
  return createHmac('sha256', key).update(parsed.identity).digest('hex')
}
