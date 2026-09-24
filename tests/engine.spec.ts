import { describe, it, expect, afterEach } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { parseModels, providerIdFor, type ManagerModel } from '../src/config-store.js'
import { modelReady, toPiModel, ensureRunning } from '../src/adapter.js'
import type { ControlClient } from '../src/control-client.js'

/**
 * 双引擎支持。
 *
 * 管理器 v1.3 起一套界面管两种引擎，`models[].engine` 标明归属：
 *   - `llamacpp`：Windows 原生 `.gguf`，就绪看 `/health`
 *   - `ninfer`：WSL 内 `.ninfer`，**没有 `/health`**，就绪只能看 `/v1/models`
 *
 * 这些用例锁定「引擎差异被正确消化」：解析阶段识别引擎、就绪探测走对端点、
 * 视觉能力从引擎各自的声明处读取。
 */

/** 起一个假上游，按需提供 /health 与 /v1/models */
async function startUpstream(opts: {
  health?: boolean
  models?: boolean
}): Promise<{ port: number; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    hits.push(url)
    if (url.startsWith('/health') && opts.health) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (url.startsWith('/v1/models') && opts.models) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'x' }] }))
      return
    }
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end('{"error":"loading"}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function makeModel(over: Partial<ManagerModel> = {}): ManagerModel {
  return {
    id: 'm',
    name: 'M',
    alias: 'M',
    port: 1,
    ctxK: 32,
    vision: false,
    engine: 'llamacpp',
    ...over,
  }
}

describe('解析 engine 字段', () => {
  it('缺省按 llamacpp 处理（兼容旧版 models.json）', () => {
    const { models } = parseModels(
      JSON.stringify({ models: [{ id: 'a', name: 'A', alias: 'A', port: 8080, ctxK: 32 }] }),
    )
    expect(models[0]!.engine).toBe('llamacpp')
  })

  it('engine=ninfer 被识别', () => {
    const { models } = parseModels(
      JSON.stringify({
        models: [{ id: 'n', name: 'N', alias: 'N', port: 8081, ctxK: 32, engine: 'ninfer' }],
      }),
    )
    expect(models[0]!.engine).toBe('ninfer')
  })

  it('未知 engine 值退化为 llamacpp，而不是丢弃该条', () => {
    const { models, skipped } = parseModels(
      JSON.stringify({
        models: [{ id: 'x', name: 'X', alias: 'X', port: 8080, ctxK: 32, engine: 'vllm' }],
      }),
    )
    expect(skipped).toEqual([])
    expect(models).toHaveLength(1)
    expect(models[0]!.engine).toBe('llamacpp')
  })

  it('llamacpp 的视觉能力仍然要求 mmproj 文件存在', () => {
    const { models } = parseModels(
      JSON.stringify({
        models: [
          { id: 'a', name: 'A', alias: 'A', port: 8080, ctxK: 32, engine: 'llamacpp', vision: true },
        ],
      }),
    )
    // vision:true 但没有 mmproj → 不能看图
    expect(models[0]!.vision).toBe(false)
  })

  it('NInfer 的视觉能力读 ninfer.vision（.ninfer 自包含，没有 mmproj 文件）', () => {
    const { models } = parseModels(
      JSON.stringify({
        models: [
          {
            id: 'n',
            name: 'N',
            alias: 'N',
            port: 8081,
            ctxK: 32,
            engine: 'ninfer',
            mmproj: null,
            ninfer: { vision: true },
          },
        ],
      }),
    )
    expect(models[0]!.vision).toBe(true)
  })

  it('NInfer 顶层 vision=true 也算（管理器两种写法都出现过）', () => {
    const { models } = parseModels(
      JSON.stringify({
        models: [{ id: 'n', name: 'N', alias: 'N', port: 8081, ctxK: 32, engine: 'ninfer', vision: true }],
      }),
    )
    expect(models[0]!.vision).toBe(true)
  })

  it('NInfer 没有视觉声明时不是视觉模型', () => {
    const { models } = parseModels(
      JSON.stringify({
        models: [{ id: 'n', name: 'N', alias: 'N', port: 8081, ctxK: 32, engine: 'ninfer' }],
      }),
    )
    expect(models[0]!.vision).toBe(false)
  })

  it('真实 models.json 的三条记录都能解析（含中文名与 NInfer）', () => {
    const raw = JSON.stringify({
      version: 1,
      models: [
        {
          id: 'reap',
          name: 'Qwen3.6-VL-REAP-26B-A3B 视觉',
          alias: 'Qwen3.6-VL-REAP-26B-A3B',
          file: 'x.gguf',
          mmproj: 'mmproj.gguf',
          ctxK: 90,
          port: 8082,
          vision: true,
          engine: 'llamacpp',
        },
        {
          id: 'qwen3-8-27b-gsq-rco',
          name: 'Qwen3.8-27B GSQ-RCO',
          alias: 'Qwen3.8-27B-GSQ-RCO-IQ3_S',
          ctxK: 64,
          port: 8080,
          vision: true,
          mmproj: 'mmproj-bf16.gguf',
          engine: 'llamacpp',
        },
        {
          id: 'qwen3-8-27b',
          name: 'qwen3.8-27b',
          alias: 'qwen3.8-27b',
          file: '/root/models/qwen3_8_27b.ninfer',
          mmproj: null,
          ctxK: 32,
          port: 8081,
          vision: false,
          engine: 'ninfer',
          ninfer: { vision: true },
        },
      ],
    })
    const { models, skipped } = parseModels(raw)
    expect(skipped).toEqual([])
    expect(models.map((m) => m.engine)).toEqual(['llamacpp', 'llamacpp', 'ninfer'])
    // NInfer 那条：顶层 vision=false，但 ninfer.vision=true
    expect(models[2]!.vision).toBe(true)
    expect(models[2]!.name).toBe('qwen3.8-27b')
  })
})

describe('按引擎选择就绪判据', () => {
  it('llamacpp 走 /health，且不碰 /v1/models', async () => {
    const up = await startUpstream({ health: true, models: true })
    cleanups.push(up.close)

    expect(await modelReady(up.port, 2_000, 'llamacpp')).toBe(true)
    expect(up.hits.some((h) => h.startsWith('/health'))).toBe(true)
    expect(up.hits.some((h) => h.startsWith('/v1/models'))).toBe(false)
  })

  it('ninfer 走 /v1/models —— 它没有 /health', async () => {
    // 这个上游只提供 /v1/models（正如 ninfer-serve）
    const up = await startUpstream({ health: false, models: true })
    cleanups.push(up.close)

    expect(await modelReady(up.port, 2_000, 'ninfer')).toBe(true)
    expect(up.hits.some((h) => h.startsWith('/health'))).toBe(false)
  })

  it('ninfer 在 /v1/models 还没起来时判为未就绪（端口已通但仍在 prewarm）', async () => {
    const up = await startUpstream({ health: true, models: false })
    cleanups.push(up.close)

    // 关键：如果误用 /health，这里会得到 true，与真实情况相反
    expect(await modelReady(up.port, 2_000, 'ninfer')).toBe(false)
  })

  it('llamacpp 在 /health 返回非 ok 时判为未就绪', async () => {
    const up = await startUpstream({ health: false, models: true })
    cleanups.push(up.close)

    // 关键：如果误用 /v1/models，这里会得到 true
    expect(await modelReady(up.port, 2_000, 'llamacpp')).toBe(false)
  })

  it('默认引擎是 llamacpp（不传第三个参数时行为不变）', async () => {
    const up = await startUpstream({ health: true, models: true })
    cleanups.push(up.close)
    expect(await modelReady(up.port)).toBe(true)
  })
})

describe('ensureRunning 按引擎探测', () => {
  it('NInfer 已就绪时不再请求管理器启动', async () => {
    const up = await startUpstream({ models: true })
    cleanups.push(up.close)

    let started = 0
    const client = {
      available: true,
      start: async () => {
        started += 1
        return { ok: true }
      },
    } as unknown as ControlClient

    const out = await ensureRunning(makeModel({ port: up.port, engine: 'ninfer' }), client)
    expect(out).toEqual({ ok: true, started: false })
    expect(started, '已就绪就不该触发启动').toBe(0)
  })

  it('NInfer 未就绪时会请求管理器启动', async () => {
    const up = await startUpstream({ models: false })
    cleanups.push(up.close)

    let started = 0
    const client = {
      available: true,
      start: async () => {
        started += 1
        return { ok: true }
      },
    } as unknown as ControlClient

    // 端口已在监听 → 插件应「等它」，而不是重复启动
    const out = await ensureRunning(makeModel({ port: up.port, engine: 'ninfer' }), client, {
      timeoutMs: 60,
      pollMs: 15,
    })
    expect(out.ok).toBe(false)
    expect(started, '端口已通说明正在加载，不该重复启动').toBe(0)
    // 超时文案要提到 NInfer，便于定位
    expect(out.error).toContain('NInfer')
  })
})

describe('provider 描述符', () => {
  it('NInfer 视觉模型带 image 输入', () => {
    const m = makeModel({ engine: 'ninfer', vision: true, alias: 'n1' })
    expect(toPiModel(m).input).toEqual(['text', 'image'])
  })

  it('非视觉模型只有 text', () => {
    const m = makeModel({ engine: 'llamacpp', vision: false, alias: 'l1' })
    expect(toPiModel(m).input).toEqual(['text'])
  })

  it('provider id 前缀与引擎无关，只由模型 id 决定', () => {
    expect(providerIdFor('qwen3-8-27b')).toBe('local-llm-qwen3-8-27b')
  })
})
