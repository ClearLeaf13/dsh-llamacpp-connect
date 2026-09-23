import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { ControlClient } from '../src/control-client.js'
import type { ManagerLocation } from '../src/discovery.js'

let server: Server
let port: number
/** 记录收到的请求，用于断言鉴权头与请求体 */
let received: Array<{ method: string; url: string; auth?: string; body: string }> = []
/** 由各用例覆盖，决定服务端如何响应 */
let handler: (req: { url: string; body: string }, res: any) => void

beforeEach(async () => {
  received = []
  handler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  }

  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        body,
      })
      handler({ url: req.url ?? '', body }, res)
    })
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

function loc(overrides: Partial<ManagerLocation> = {}): ManagerLocation {
  return {
    dir: '/tmp/x',
    modelsPath: '/tmp/x/models.json',
    apiPort: port,
    apiToken: 'secret-token',
    ...overrides,
  }
}

describe('ControlClient', () => {
  it('不可用时直接报错，不发请求', async () => {
    const c = new ControlClient(loc({ apiPort: undefined, apiToken: undefined }))
    expect(c.available).toBe(false)
    const r = await c.status()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('控制接口不可用')
    expect(received).toHaveLength(0)
  })

  it('status 带上 Bearer 令牌', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, models: [], anyRunning: false }))
    }
    const c = new ControlClient(loc())
    const r = await c.status()
    expect(r.ok).toBe(true)
    expect(received[0]!.auth).toBe('Bearer secret-token')
    expect(received[0]!.url).toBe('/status')
  })

  it('start 发送 POST 与模型 id', async () => {
    const c = new ControlClient(loc())
    await c.start('my-model', 16)
    expect(received[0]!.method).toBe('POST')
    expect(received[0]!.url).toBe('/start')
    expect(JSON.parse(received[0]!.body)).toEqual({ id: 'my-model', ctxK: 16 })
  })

  it('start 不带 ctxK 时请求体不含该字段', async () => {
    const c = new ControlClient(loc())
    await c.start('m')
    expect(JSON.parse(received[0]!.body)).toEqual({ id: 'm' })
  })

  it('服务端返回 401 时给出明确错误', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: '令牌无效' }))
    }
    const c = new ControlClient(loc())
    const r = await c.status()
    // 401 的业务错误来自响应体
    expect(r.ok).toBe(false)
  })

  it('start 被拒绝时透传原因', async () => {
    handler = (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: '端口已被占用' }))
    }
    const c = new ControlClient(loc())
    const r = await c.start('m')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('端口已被占用')
  })

  it('响应不是 JSON 时报错而不是崩溃', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('this is not json')
    }
    const c = new ControlClient(loc())
    const r = await c.status()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不是 JSON')
  })

  it('连接被拒绝时给出可读提示', async () => {
    // 取一个真实空闲端口再释放，确保它是「无人监听」而非非法端口
    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const freePort = (probe.address() as { port: number }).port
    await new Promise<void>((r) => probe.close(() => r()))

    const c = new ControlClient(loc({ apiPort: freePort }))
    const r = await c.status()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未响应')
  })

  it('stop 发送 POST', async () => {
    const c = new ControlClient(loc())
    await c.stop()
    expect(received[0]!.method).toBe('POST')
    expect(received[0]!.url).toBe('/stop')
  })

  it('status 在 ok:false 响应下仍标记失败', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: '内部错误' }))
    }
    const c = new ControlClient(loc())
    const r = await c.status()
    expect(r.ok).toBe(false)
  })
})
