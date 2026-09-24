import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ensureRunning, portOpen, modelReady, toPiModel, READY_TIMEOUT_MS } from '../src/adapter.js'
import { ControlClient } from '../src/control-client.js'
import type { ManagerModel } from '../src/config-store.js'

let server: Server | undefined
let port = 0
let startCalls: string[] = []

/** 起一个假的 llama-server：提供真实的 /health 就绪信号 */
async function listen(): Promise<number> {
  server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return (server!.address() as AddressInfo).port
}

/** 起一个假的管理器控制 API；start 一律成功 */
async function listenControl(): Promise<number> {
  const s = createServer((req, res) => {
    if (req.url === '/start') {
      startCalls.push('start')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  controlServers.push(s)
  return (s.address() as AddressInfo).port
}

/** 给需要轮询等待的用例留足时间，避免被 vitest 默认 5s 掐断 */
const WAIT_TIMEOUT = 20_000

let controlServers: Server[] = []

afterEach(async () => {
  for (const s of [...controlServers, server]) {
    if (s) await new Promise<void>((r) => s.close(() => r()))
  }
  controlServers = []
  server = undefined
  startCalls = []
})

function model(overrides: Partial<ManagerModel> = {}): ManagerModel {
  return { id: 'm', name: 'Test Model', alias: 'test-alias', port, ctxK: 32, vision: false, ...overrides }
}

describe('portOpen', () => {
  it('监听中的端口返回 true', async () => {
    port = await listen()
    expect(await portOpen(port)).toBe(true)
  })

  it('未监听的端口返回 false', async () => {
    expect(await portOpen(59999)).toBe(false)
  })
})

describe('ensureRunning', () => {
  it('已在运行时直接放行，不调管理器', async () => {
    port = await listen()
    const controlPort = await listenControl()
    const client = new ControlClient({
      dir: '/x', modelsPath: '/x/models.json', apiPort: controlPort, apiToken: 't',
    })

    const r = await ensureRunning(model(), client)
    expect(r.ok).toBe(true)
    expect(r.started).toBe(false)
    expect(startCalls).toHaveLength(0)
  }, WAIT_TIMEOUT)

  it('未运行且无控制接口时给出可操作的错误', async () => {
    port = 59998
    const client = new ControlClient({ dir: '/x', modelsPath: '/x/models.json' })
    const r = await ensureRunning(model(), client)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('无法自动启动')
    expect(r.error).toContain('59998')
  })

  it('未运行时请管理器启动并等待就绪', async () => {
    // 先占一个端口号，然后释放，保证 nextPort 可用但当前无人监听
    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const freePort = (probe.address() as AddressInfo).port
    await new Promise<void>((r) => probe.close(() => r()))

    const controlPort = await listenControl()
    const client = new ControlClient({
      dir: '/x', modelsPath: '/x/models.json', apiPort: controlPort, apiToken: 't',
    })

    // 管理器「启动」后，真正的 llama-server 延迟一小段才开始服务
    const late = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    setTimeout(() => { void late.listen(freePort, '127.0.0.1') }, 200)
    controlServers.push(late)

    const r = await ensureRunning(model({ port: freePort }), client, {
      timeoutMs: 5000,
      pollMs: 100,
    })

    expect(startCalls).toContain('start')
    expect(r.ok).toBe(true)
    expect(r.started).toBe(true)
  }, WAIT_TIMEOUT)

  it('启动后端口始终不就绪时报超时', async () => {
    port = 59997
    const controlPort = await listenControl()
    const client = new ControlClient({
      dir: '/x', modelsPath: '/x/models.json', apiPort: controlPort, apiToken: 't',
    })

    const r = await ensureRunning(model({ port }), client, { timeoutMs: 400, pollMs: 100 })
    expect(r.ok).toBe(false)
    expect(r.started).toBe(true)
    expect(r.error).toContain('仍未就绪')
  })

  it('管理器拒绝启动时透传原因', async () => {
    port = 59996
    const s = createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: '模型正在运行，请先停止' }))
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    controlServers.push(s)

    const client = new ControlClient({
      dir: '/x', modelsPath: '/x/models.json',
      apiPort: (s.address() as AddressInfo).port, apiToken: 't',
    })
    const r = await ensureRunning(model(), client, { timeoutMs: 1000, pollMs: 100 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('模型正在运行')
  })
})

describe('modelReady', () => {
  it('健康检查返回 ok 时为就绪', async () => {
    const s = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    controlServers.push(s)
    const p = (s.address() as AddressInfo).port
    expect(await modelReady(p)).toBe(true)
  })

  it('端口通但返回 503 时不算就绪', async () => {
    // 这正是 llama-server 加载模型期间的行为：
    // 端口已监听，但 /health 不可用
    const s = createServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Loading model' } }))
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    controlServers.push(s)
    const p = (s.address() as AddressInfo).port

    // 端口是通的
    expect(await portOpen(p)).toBe(true)
    // 但没就绪
    expect(await modelReady(p)).toBe(false)
  })

  it('非 JSON 响应不算就绪', async () => {
    const s = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('nope')
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    controlServers.push(s)
    expect(await modelReady((s.address() as AddressInfo).port)).toBe(false)
  })

  it('端口未监听时不算就绪', async () => {
    expect(await modelReady(59995)).toBe(false)
  })
})

describe('ensureRunning 等待就绪', () => {
  it('端口开了但模型仍在加载时会等待，不重复触发启动', async () => {
    // 服务端先返回 503，600ms 后转为 ready
    let ready = false
    const s = createServer((_req, res) => {
      if (ready) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Loading model' } }))
      }
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    controlServers.push(s)
    const p = (s.address() as AddressInfo).port

    setTimeout(() => { ready = true }, 600)

    const controlPort = await listenControl()
    const client = new ControlClient({
      dir: '/x', modelsPath: '/x/models.json', apiPort: controlPort, apiToken: 't',
    })

    const r = await ensureRunning(model({ port: p }), client, {
      timeoutMs: 8000,
      pollMs: 100,
    })

    expect(r.ok).toBe(true)
    // 已在加载中，不应再让管理器启动一次
    expect(r.started).toBe(false)
    expect(startCalls).toHaveLength(0)
  })
})

describe('toPiModel', () => {
  it('指向该模型的端口并带上别名', () => {
    const m = toPiModel(model({ id: 'vl', port: 8081, alias: 'Qwen-VL', ctxK: 32 }))
    expect(m.baseUrl).toBe('http://127.0.0.1:8081/v1')
    expect(m.id).toBe('Qwen-VL')
    expect(m.provider).toBe('local-llm-vl')
    expect(m.api).toBe('openai-completions')
  })

  it('vision 模型声明 image 输入', () => {
    expect(toPiModel(model({ vision: false })).input).toEqual(['text'])
    expect(toPiModel(model({ vision: true })).input).toEqual(['text', 'image'])
  })

  it('contextWindow 由 ctxK 换算', () => {
    expect(toPiModel(model({ ctxK: 32 })).contextWindow).toBe(32768)
  })

  it('maxTokens 不超过上下文一半且上限 8192', () => {
    // 小上下文：受一半限制
    expect(toPiModel(model({ ctxK: 4 })).maxTokens).toBe(2048)
    // 大上下文：受 8192 上限
    expect(toPiModel(model({ ctxK: 256 })).maxTokens).toBe(8192)
  })

  it('成本字段齐备（缺失会让统计显示 NaN）', () => {
    const m = toPiModel(model())
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('就绪超时默认 180 秒', () => {
    expect(READY_TIMEOUT_MS).toBe(180_000)
  })
})
