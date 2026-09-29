import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toNodeListener } from 'h3'
import { createExternalNodeAgent } from './http'

describe('external node Control API', () => {
  let server: ReturnType<typeof createServer>
  let base: string
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'metacubexd-node-http-'))
    const agent = createExternalNodeAgent({
      providerPath: join(dir, 'manual.txt'),
      mihomoApiUrl: 'http://127.0.0.1:1',
      mihomoSecret: 'hidden-secret',
      controlToken: 'control-secret',
    })
    server = createServer(toNodeListener(agent.router))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('test listener unavailable')
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  it('advertises only node capability in external mode', async () => {
    const response = await fetch(`${base}/api/control/info`)
    expect(response.status).toBe(200)
    expect(
      ((await response.json()) as { features: string[] }).features,
    ).toEqual(['nodes'])
  })

  it('requires a bearer token and never puts submitted credentials in errors', async () => {
    const unauthorized = await fetch(`${base}/api/control/nodes`)
    expect(unauthorized.status).toBe(401)
    const response = await fetch(`${base}/api/control/nodes/preview`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer control-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: 'vless://my-private-password@bad' }),
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('INVALID_NODE_URI')
    expect(body).not.toContain('my-private-password')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})
