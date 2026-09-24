import { describe, it, expect, afterEach } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 图片输入：adapter 必须提供 `resolveAttachments`。
 *
 * 真实故障：上传图片后报
 *   pi-ai image input requires the durable attachment service
 *
 * 出处：dsh-llm-pi-ai 的 stream 路径
 *
 *   const containsImage = options.messages.some((m) => contentHasImage(m.content))
 *   const attachments = containsImage ? this.config.resolveAttachments?.() : void 0
 *   if (containsImage && attachments === void 0)
 *     throw new LlmError('pi-ai image input requires the durable attachment service', ...)
 *
 * 我们原先构造 `PiAiAdapter` 时**没有传** `resolveAttachments`，于是 `?.()` 得到
 * undefined，只要消息里带图片就必然抛。
 *
 * 官方构造（dsh-llm-pi-ai:2634-2635）：
 *   resolveAttachments: () => ctx.get('attachments')
 *   resolveImageAccess: (attachments, ref) =>
 *     resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref)
 *
 * 这两条测试一正一反：
 *   · 宿主**有** attachments 服务 → 不得再抛那句
 *   · 宿主**没有**该服务       → 必须抛那句（证明图片路径确实被走到，
 *                                而不是因为别的原因「恰好没报错」）
 */

const LIB = join(process.cwd(), 'lib', 'index.js')
const PLUGIN_URL = 'file://' + LIB.replace(/\\/g, '/')
const PROVIDER = 'local-llm-vl'

const SSE =
  'data: ' +
  JSON.stringify({
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'qwen-vl',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
  }) +
  '\n\n' +
  'data: [DONE]\n\n'

async function freePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as AddressInfo).port
  await new Promise<void>((r) => srv.close(() => r()))
  return port
}

type Upstream = { port: number; close: () => Promise<void> }

async function startUpstream(): Promise<Upstream> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.end(SSE)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

/** 假的视觉模型（vision: true → piModel.input 含 image） */
async function startManager(modelPort: number): Promise<Upstream> {
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/status')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          models: [
            {
              id: 'vl',
              name: 'Qwen VL',
              alias: 'Qwen-VL',
              port: modelPort,
              ctxK: 64,
              mmproj: 'mm.gguf',
              vision: true,
              running: true,
            },
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
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

/** 跑一次带图片的 stream，返回拼接后的「流内容 + 抛出的错误」文本 */
async function runImageStream(options: { withAttachments: boolean }): Promise<string> {
  const upstream = await startUpstream()
  cleanup.push(() => upstream.close())
  const manager = await startManager(upstream.port)
  cleanup.push(() => manager.close())

  const dir = await mkdtemp(join(tmpdir(), 'local-llm-img-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  await writeFile(
    join(dir, 'models.json'),
    JSON.stringify({
      version: 1,
      models: [
        {
          id: 'vl',
          name: 'Qwen VL',
          alias: 'Qwen-VL',
          port: upstream.port,
          ctxK: 64,
          mmproj: 'mm.gguf',
          vision: true,
        },
      ],
    }),
    'utf8',
  )
  await writeFile(join(dir, 'api-port.txt'), String(manager.port), 'utf8')
  await writeFile(join(dir, 'api-token.txt'), 'test-token', 'utf8')

  const { Context } = await import('@deepseek-ai/cordis')
  const routes = new Map<string, unknown>()
  const adapters: Array<{
    listModels: (p: string) => Promise<Array<{ id: string }>>
    stream: (o: unknown) => AsyncGenerator<unknown>
  }> = []

  const root = new Context()
  root.provide('webServer', {
    exact: { has: (p: string) => routes.has(p) },
    register(route: { path: string }) {
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
  if (options.withAttachments) {
    // 图的「持久附件服务」：php 形状只需 imageHostPath(ref) 返回宿主路径
    root.provide('attachments', { imageHostPath: () => '/tmp/fake-image.png' })
    // 把宿主路径映射进执行世界
    root.provide('fs', { processPathFromHostPath: (p: string) => p })
  }

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

  const deadline = Date.now() + 5000
  while (adapters.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  expect(adapters.length, '应当注册了 provider').toBeGreaterThan(0)

  const adapter = adapters[0]!
  const models = await adapter.listModels(PROVIDER)
  expect(models.length, '应当是视觉模型').toBe(1)

  const chunks: unknown[] = []
  let thrown: unknown
  try {
    for await (const chunk of adapter.stream({
      provider: PROVIDER,
      model: models[0]!.id,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图里有什么？' },
            {
              type: 'image',
              attachment: {
                attachmentId: 'sha256:0123456789abcdef',
                mediaType: 'image/png',
                bytes: 1024,
                width: 8,
                height: 8,
              },
            },
          ],
        },
      ],
    })) {
      chunks.push(chunk)
    }
  } catch (e) {
    thrown = e
  }

  return `${JSON.stringify(chunks)}\n${String((thrown as Error | undefined)?.message ?? '')}`
}

describe('图片输入需要 durable attachment service', () => {
  it('宿主有 attachments 服务时，不再抛「requires the durable attachment service」', async () => {
    if (!existsSync(LIB)) throw new Error(`缺少构建产物 ${LIB}，请先 pnpm run build`)
    const outcome = await runImageStream({ withAttachments: true })
    expect(outcome).not.toMatch(/durable attachment service/)
  })

  it('负对照：宿主没有该服务时，同样的图片消息确实抛那句（证明图片路径被走到）', async () => {
    const outcome = await runImageStream({ withAttachments: false })
    expect(
      outcome,
      '没有附件服务时应当如实报错 —— 否则说明图片路径根本没被走到，前一条测试就是空转',
    ).toMatch(/durable attachment service/)
  })
})
