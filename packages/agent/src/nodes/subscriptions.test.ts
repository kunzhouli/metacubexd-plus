import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseNodeUri } from './parser'
import { createSubscriptionStore } from './subscriptions'
import type { MihomoClient, ProviderData } from './store'

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe('subscription file providers', () => {
  async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'metacubexd-subscriptions-'))
    dirs.push(dir)
    const uriPath = join(dir, 'subscriptions-uri.txt')
    const yamlPath = join(dir, 'subscriptions-yaml.yaml')
    await writeFile(
      uriPath,
      'proxies:\n  - name: "Subscriptions URI empty (DIRECT)"\n    type: direct\n',
      { mode: 0o600 },
    )
    await writeFile(
      yamlPath,
      'proxies:\n  - name: "Subscriptions YAML empty (DIRECT)"\n    type: direct\n',
      { mode: 0o600 },
    )
    const live: Record<string, ProviderData> = {
      manual: { proxies: [{ name: 'HK' }] },
      'subscriptions-uri': { proxies: [] },
      'subscriptions-yaml': { proxies: [] },
    }
    let failReload = false
    const mihomo: MihomoClient = {
      provider: vi.fn(async () => live.manual!),
      allProviders: vi.fn(async () => live),
      reload: vi.fn(async () => {}),
      healthcheck: vi.fn(async () => {}),
      test: vi.fn(async () => 1),
      groups: vi.fn(async () => []),
      select: vi.fn(async () => {}),
      version: vi.fn(async () => true),
      namedProvider: vi.fn(async (name) => live[name]!),
      reloadNamed: vi.fn(async (name) => {
        if (failReload) {
          failReload = false
          throw new Error('MIHOMO_UNAVAILABLE')
        }
        const content = await readFile(
          name === 'subscriptions-uri' ? uriPath : yamlPath,
          'utf8',
        )
        live[name] = {
          proxies: content.startsWith('proxies:\n  - name: "Subscriptions')
            ? [
                {
                  name:
                    name === 'subscriptions-uri'
                      ? 'Subscriptions URI empty (DIRECT)'
                      : 'Subscriptions YAML empty (DIRECT)',
                },
              ]
            : name === 'subscriptions-uri'
              ? content
                  .trim()
                  .split('\n')
                  .map((uri) => ({ name: parseNodeUri(uri).name }))
              : (parse(content) as { proxies: { name: string }[] }).proxies.map(
                  ({ name }) => ({ name }),
                ),
        }
      }),
      healthcheckNamed: vi.fn(async () => {}),
    }
    const bodies = new Map([
      [
        'https://example.com/uri?token=private-token',
        'ss://YWVzLTEyOC1nY206cGFzcw@edge.example:443#HK',
      ],
      [
        'https://example.com/yaml?token=private-token',
        'proxies:\n  - name: HK\n    type: ss\n    server: yaml.example\n    port: 8443\n    cipher: aes-128-gcm\n    password: private-password\n',
      ],
    ])
    const store = createSubscriptionStore(
      dir,
      mihomo,
      false,
      async (url) => bodies.get(url) ?? '',
    )
    return {
      dir,
      store,
      uriPath,
      yamlPath,
      mihomo,
      bodies,
      failNextReload: () => {
        failReload = true
      },
    }
  }

  it('previews sources, renames collisions, keeps URLs private and writes backups', async () => {
    const { dir, store, uriPath, yamlPath } = await fixture()
    const firstUrl = 'https://example.com/uri?token=private-token'
    const secondUrl = 'https://example.com/yaml?token=private-token'
    expect((await store.preview(firstUrl)).items[0]?.name).toBe('HK')
    const first = await store.add({
      name: 'URI source',
      url: firstUrl,
      intervalHours: 12,
    })
    const second = await store.add({
      name: 'YAML source',
      url: secondUrl,
      intervalHours: 0,
    })
    expect(first).not.toHaveProperty('url')
    expect(first.count).toBe(1)
    expect(second.format).toBe('yaml')
    expect(await store.reveal(first.id)).toBe(firstUrl)
    expect(parseNodeUri((await readFile(uriPath, 'utf8')).trim()).name).toBe(
      'HK (2)',
    )
    expect(
      (
        parse(await readFile(yamlPath, 'utf8')) as {
          proxies: { name: string }[]
        }
      ).proxies[0]?.name,
    ).toBe('HK (3)')
    expect(
      (await stat(join(dir, 'subscriptions.meta.json'))).mode & 0o777,
    ).toBe(0o600)
    expect((await stat(`${uriPath}.bak`)).mode & 0o777).toBe(0o600)
    expect((await stat(`${yamlPath}.bak`)).mode & 0o777).toBe(0o600)
  })

  it('restores both provider files if Mihomo rejects an update', async () => {
    const { store, uriPath, yamlPath, failNextReload } = await fixture()
    const added = await store.add({
      name: 'URI source',
      url: 'https://example.com/uri?token=private-token',
    })
    const before = await Promise.all(
      [uriPath, yamlPath].map((path) => readFile(path, 'utf8')),
    )
    failNextReload()
    await expect(store.remove(added.id)).rejects.toThrow(
      'PROVIDER_UPDATE_FAILED',
    )
    expect(
      await Promise.all(
        [uriPath, yamlPath].map((path) => readFile(path, 'utf8')),
      ),
    ).toEqual(before)
    expect(await store.list()).toHaveLength(1)
  })

  it('refreshes an interval source when due without changing its identity', async () => {
    const { store, uriPath, bodies } = await fixture()
    const url = 'https://example.com/uri?token=private-token'
    const added = await store.add({ name: 'URI source', url, intervalHours: 1 })
    bodies.set(url, 'ss://YWVzLTEyOC1nY206cGFzcw@edge.example:443#NewName')
    vi.spyOn(Date, 'now').mockReturnValue(added.lastUpdatedAt + 3_600_001)
    await store.refreshDue()
    expect((await store.list())[0]?.id).toBe(added.id)
    expect(parseNodeUri((await readFile(uriPath, 'utf8')).trim()).name).toBe(
      'NewName',
    )
  })
})
