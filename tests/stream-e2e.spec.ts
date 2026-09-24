import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 端到端：从「插件被宿主加载」到「请求真的打到模型端点并拿回内容」。
 *
 * 这条测试是为了覆盖两个**只有在真实请求路径上才会暴露**的故障：
 *
 * 1. `idleWatchdog timeoutMs must be a positive finite number...`
 *    —— 手搓 pi-ai profile 绕过了 `resolveProfiles()`，缺 `streamIdleTimeoutMs`
 * 2. `Provider is not configured: <provider>`
 *    —— provider 的 `auth.apiKey.resolve` 返回了 `undefined`，
 *       pi-ai 的 `applyAuth()` 只判断真值，于是请求一发出就被拒
 *
 * 两者都不会在「只注册/只枚举模型」时出现，必须真的发起一次 stream。
 * 这里用一个**假的 OpenAI 兼容 SSE 服务**当上游，断言最终真的收到内容片段。
 */

const LIB = join(process.cwd(), 'lib', 'index.js')
const PLUGIN_URL = 'file://' + LIB.replace(/\\/g, '/')

const PROVIDER = 'llamacpp-balanced'

/** 一个最小可用的 OpenAI 兼容 SSE 响应 */
const SSE_BODY =
  'data: ' +
  JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'qwen',
    choices: [{ index: 0, delta: { role: 'assistant', content: '你好' }, finish_reason: null }],
  }) +
  '\n\n' +
  'data: ' +
  JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'qwen',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }) +
  '\n\n' +
  'data: [DONE]\n\n'

type Server$ = { port: number; close: () => Promise<void>; requests: string[] }

/** 假的上游模型端点（OpenAI 兼容） */
async function startFakeModel(): Promise<Server$> {
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    if ((req.url ?? '').includes('/chat/completions')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.end(SSE_BODY)
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

/** 假的管理器控制接口：报告模型正在运行 */
async function startFakeManager(modelPort: number): Promise<Server$> {
  const server: Server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/status')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          models: [
            { id: 'balanced', name: 'Qwen 35B', alias: 'Qwen-35B', port: modelPort, running: true },
          ],
        }),
      )
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return {
    port: (server.address() as AddressInfo).port,
    requests: [],
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

describe('请求路径端到端', () => {
  it('能真的打到模型端点并收到内容（不抛 idleWatchdog / Provider is not configured）', async () => {
    if (!existsSync(LIB)) throw new Error(`缺少构建产物 ${LIB}，请先 pnpm run build`)

    const model = await startFakeModel()
    cleanup.push(() => model.close())
    const manager = await startFakeManager(model.port)
    cleanup.push(() => manager.close())

    const dir = await mkdtemp(join(tmpdir(), 'llamacpp-e2e-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    await writeFile(
      join(dir, 'models.json'),
      JSON.stringify({
        version: 1,
        models: [
          {
            id: 'balanced',
            name: 'Qwen 35B',
            alias: 'Qwen-35B',
            port: model.port,
            ctxK: 32,
            vision: false,
          },
        ],
      }),
      'utf8',
    )
    await writeFile(join(dir, 'api-port.txt'), String(manager.port), 'utf8')
    await writeFile(join(dir, 'api-token.txt'), 'test-token', 'utf8')

    // ---- 真实 Cordis 宿主 ----
    const { Context } = await import('@deepseek-ai/cordis')
    const routes = new Map<
      string,
      { handler: (req: { method?: string }, res: unknown) => unknown }
    >()
    const adapters: Array<{
      listModels: (p: string) => Promise<Array<{ id: string }>>
      stream: (o: unknown) => AsyncGenerator<unknown>
    }> = []

    const root = new Context()
    root.provide('webServer', {
      exact: { has: (p: string) => routes.has(p) },
      register(route: { path: string; handler: (req: { method?: string }, res: unknown) => unknown }) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    })
    root.provide('llm', {
      registerAdapter: (_ids: string[], adapter: (typeof adapters)[number]) => {
        adapters.push(adapter)
        return () => {}
      },
    })

    const mod = (await import(PLUGIN_URL)) as {
      name: string
      inject: string[]
      Config: unknown
      apply: (ctx: unknown, config: unknown) => () => void
    }
    await root.plugin(
      { name: mod.name, inject: mod.inject, Config: mod.Config, apply: mod.apply },
      { managerDir: dir },
    )

    // 等首次同步把 provider 注册好
    const deadline = Date.now() + 5000
    while (adapters.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(adapters.length, '应当注册了 provider').toBeGreaterThan(0)

    const adapter = adapters[0]!
    const models = await adapter.listModels(PROVIDER)
    expect(models.length, '应当能枚举出模型').toBe(1)

    // ---- 真的发一次 stream ----
    const chunks: unknown[] = []
    let failure: unknown
    try {
      for await (const chunk of adapter.stream({
        provider: PROVIDER,
        model: models[0]!.id,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) {
        chunks.push(chunk)
      }
    } catch (e) {
      failure = e
    }

    // pi-ai 把失败**作为流片段**返回，而不是抛出 —— 所以必须检查片段内容，
    // 只看「有没有抛错」会漏掉真实故障（这正是第一版断言瞎掉的原因）。
    const serialized = JSON.stringify(chunks)
    expect(serialized, '流里不得出现 idleWatchdog（profile 缺 streamIdleTimeoutMs）').not.toMatch(
      /idleWatchdog/,
    )
    expect(
      serialized,
      '流里不得出现 Provider is not configured（auth.apiKey 缺失或 resolve 返回 undefined）',
    ).not.toMatch(/Provider is not configured/)
    expect(
      String((failure as Error | undefined)?.message ?? ''),
      '也不应抛出这两类错误',
    ).not.toMatch(/idleWatchdog|Provider is not configured/)

    expect(model.requests, '请求应当真的打到模型端点').toContain('POST /v1/chat/completions')
    expect(chunks.length, '应当收到流片段').toBeGreaterThan(0)
    expect(serialized, '流里应当带上游返回的内容').toContain('你好')
    expect(serialized, '不应出现任何错误片段').not.toMatch(/"kind":"error"/)
  })
})
