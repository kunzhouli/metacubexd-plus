import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseNodeUri } from './parser'
import {
  createNodeStore,
  EMPTY_PROVIDER_CONTENT,
  type MihomoClient,
  type ProviderData,
} from './store'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe('share URI adapters', () => {
  const vmess = `vmess://${Buffer.from(JSON.stringify({ add: 'vm.example', port: '443', id: 'uuid-secret', ps: 'VM', extra: 'kept' })).toString('base64')}`
  const ss = `ss://${Buffer.from('aes-256-gcm:password@ss.example:8388').toString('base64')}#SS`
  it.each([
    [ss, 'ss'],
    [vmess, 'vmess'],
    [
      'vless://uuid-secret@vless.example:443?security=tls&unknown=keep#VL',
      'vless',
    ],
    ['trojan://password@trojan.example:443?unknown=keep#TR', 'trojan'],
    ['hy2://password@hy.example:443?unknown=keep#HY', 'hysteria2'],
    ['hysteria2://password@hy.example:443#HY', 'hysteria2'],
    ['tuic://uuid-secret:password@tuic.example:443?unknown=keep#TU', 'tuic'],
    ['anytls://password@any.example:443?unknown=keep#ANY', 'anytls'],
  ])('parses %s as %s and preserves options on rename', (uri, protocol) => {
    const parsed = parseNodeUri(uri)
    expect(parsed.protocol).toBe(protocol)
    expect(parsed.port).toBeGreaterThan(0)
    const renamed = parsed.withName('Renamed')
    expect(parseNodeUri(renamed).name).toBe('Renamed')
    if (uri.includes('unknown=keep')) expect(renamed).toContain('unknown=keep')
  })
  it('returns safe errors without sharing credentials', () => {
    expect(() => parseNodeUri('vless://password-secret@bad')).toThrow(
      'INVALID_NODE_URI',
    )
  })
})

describe('manual provider transactions', () => {
  async function fixture(sharedGroupRead = false) {
    const dir = await mkdtemp(join(tmpdir(), 'metacubexd-nodes-'))
    dirs.push(dir)
    const path = join(dir, 'manual.txt')
    if (sharedGroupRead) {
      await chmod(dir, 0o2750)
      await writeFile(path, EMPTY_PROVIDER_CONTENT)
      await chmod(path, 0o660)
    }
    let live: ProviderData = { proxies: [] }
    let failReload = false
    const mihomo: MihomoClient = {
      provider: vi.fn(async () => live),
      allProviders: vi.fn(async () => ({ manual: live })),
      reload: vi.fn(async () => {
        if (failReload) {
          failReload = false
          throw new Error('MIHOMO_UNAVAILABLE')
        }
        const content = await readFile(path, 'utf8')
        live = {
          proxies:
            content === EMPTY_PROVIDER_CONTENT
              ? [{ name: 'Manual empty (DIRECT)' }]
              : content
                  .split('\n')
                  .filter(Boolean)
                  .map((uri) => ({ name: parseNodeUri(uri).name })),
        }
      }),
      healthcheck: vi.fn(async () => {}),
      test: vi.fn(async () => 42),
      version: vi.fn(async () => true),
    }
    return {
      path,
      store: createNodeStore(path, mihomo, sharedGroupRead),
      failNextReload: () => {
        failReload = true
      },
    }
  }

  it('imports multiple nodes, deduplicates by identity and keeps a private backup', async () => {
    const { path, store } = await fixture()
    const one = 'vless://uuid-secret@one.example:443?unknown=keep#First'
    const same = 'vless://uuid-secret@one.example:443?unknown=keep#Other name'
    const two = 'trojan://password-secret@two.example:443#Second'
    const result = await store.importUris([one, same, two], ['HK', '自建'])
    expect(result.imported).toHaveLength(2)
    expect(result.duplicateCount).toBe(1)
    expect(result.imported[0]).not.toHaveProperty('originalUri')
    expect(await readFile(`${path}.bak`, 'utf8')).toBe('')
    expect((await store.list())[0]?.tags).toEqual(['HK', '自建'])
    expect(await store.reveal(result.imported[0]!.id)).toBe(one)
  })

  it('restores the previous file when Mihomo rejects a reload', async () => {
    const { path, store, failNextReload } = await fixture()
    await store.importUris(['trojan://password-secret@one.example:443#One'], [])
    const before = await readFile(path, 'utf8')
    failNextReload()
    await expect(
      store.importUris(['trojan://password-secret@two.example:443#Two'], []),
    ).rejects.toThrow('PROVIDER_UPDATE_FAILED')
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await store.list()).toHaveLength(1)
  })

  it('renames colliding display names without changing the original URI', async () => {
    const { store } = await fixture()
    const uris = [
      'trojan://first-secret@one.example:443#Home',
      'trojan://second-secret@two.example:443#Home',
    ]
    const result = await store.importUris(uris, [])
    expect(result.imported.map((node) => node.name)).toEqual([
      'Home',
      'Home (2)',
    ])
    expect(await store.reveal(result.imported[1]!.id)).toBe(uris[1])
    expect((await store.list()).map((node) => node.name)).toEqual([
      'Home',
      'Home (2)',
    ])
  })

  it('keeps the provider group-readable in shared-service mode', async () => {
    const { path, store } = await fixture(true)
    await store.importUris(['trojan://test-secret@one.example:443#Test'], [])
    expect((await stat(path)).mode & 0o777).toBe(0o660)
    expect((await stat(`${path}.bak`)).mode & 0o777).toBe(0o600)
    expect(await store.list()).toHaveLength(1)
    const [node] = await store.list()
    await store.remove(node!.id)
    expect(await readFile(path, 'utf8')).toBe(EMPTY_PROVIDER_CONTENT)
    expect(await store.list()).toEqual([])
  })
})
