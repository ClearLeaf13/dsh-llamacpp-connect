/**
 * 把管理器里的每个模型映射成 DSH 的一个 provider。
 *
 * 上游是 llama-server 的 OpenAI 兼容端点，因此每个 provider 只需一个
 * 指向该模型端口的 baseUrl —— 不需要代理、不需要改写请求体。
 *
 * 「选中即启动」在这里落地：DSH 请求某 provider 时，`ensureRunning` 会先
 * 问管理器该模型是否在跑，不在就跑起来并等端口就绪，然后再放行请求。
 *
 * @module dsh-llamacpp-connect/adapter
 */

import type { ManagerModel } from './config-store.js'
import { baseUrlFor, providerIdFor } from './config-store.js'
import type { ControlClient } from './control-client.js'

/** 等待模型就绪的上限；与管理器内部的 180 秒就绪窗口保持一致 */
export const READY_TIMEOUT_MS = 180_000
/** 就绪轮询间隔 */
const POLL_INTERVAL_MS = 1_000

export interface StartOutcome {
  ok: boolean
  /** 是否需要等待（已运行时为 false） */
  started: boolean
  error?: string
}

/** 端口是否已可连接 —— 用 TCP 探测，比 HTTP 更贴近「进程起来了」 */
export async function portOpen(port: number, timeoutMs = 800): Promise<boolean> {
  const net = await import('node:net')
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const done = (v: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(v)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, '127.0.0.1')
  })
}

/**
 * 模型是否已真正可服务。
 *
 * 只探端口是不够的：llama-server 会**先监听端口、后加载模型**，这期间
 * `/v1/models` 返回 503、`/health` 无响应。端口通只说明进程起来了，
 * 此时发请求会得到 503。
 *
 * 因此以 `/health` 返回 `{"status":"ok"}` 作为就绪判据。
 */
export async function modelReady(port: number, timeoutMs = 2_000): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
      if (!res.ok) return false
      const body = (await res.json()) as { status?: string }
      return body?.status === 'ok'
    } finally {
      clearTimeout(timer)
    }
  } catch {
    // 连接被拒、超时、非 JSON 都视为未就绪
    return false
  }
}

/**
 * 确保模型可服务，未就绪则通过管理器启动它。
 *
 * 判据是 `/health` 而不是端口可连 —— 见 {@link modelReady}。
 * 已在加载中的实例也会被等待，不重复触发启动。
 */
export async function ensureRunning(
  model: ManagerModel,
  client: ControlClient,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<StartOutcome> {
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS
  const pollMs = options.pollMs ?? POLL_INTERVAL_MS

  // 已经就绪：直接放行
  if (await modelReady(model.port)) return { ok: true, started: false }

  // 端口开着但没就绪 —— 说明正在加载，等它而不是重复启动
  const loading = await portOpen(model.port)

  if (!loading) {
    if (!client.available) {
      return {
        ok: false,
        started: false,
        error:
          `模型「${model.name}」未运行，且无法自动启动：` +
          '未检测到管理器的控制接口。请打开 llama.cpp 管理器，' +
          `并在其中手动启动该模型（端口 ${model.port}）。`,
      }
    }

    const started = await client.start(model.id, model.ctxK)
    if (!started.ok) {
      return { ok: false, started: true, error: `启动失败：${started.error ?? '未知原因'}` }
    }
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await modelReady(model.port)) return { ok: true, started: !loading }
    await new Promise((r) => setTimeout(r, pollMs))
  }

  return {
    ok: false,
    started: !loading,
    error:
      `已请求启动，但 ${Math.round(timeoutMs / 1000)} 秒内端口 ${model.port} 仍未就绪。` +
      '大模型首次加载可能较慢，请查看管理器日志。',
  }
}

/** pi-ai 的模型描述符 */
export interface PiModel {
  id: string
  name: string
  api: string
  provider: string
  baseUrl: string
  input: string[]
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
  compat: { maxTokensField: string }
}

/** 本地推理无计费，但字段不可省 —— 缺失会让成本统计显示 NaN */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * 构造一个模型的 pi-ai 描述符。
 *
 * contextWindow 取管理器的 ctxK；maxTokens 留出输出空间而不是等于上下文，
 * 否则长上下文模型会把整个窗口算作可用输出。
 */
export function toPiModel(model: ManagerModel): PiModel {
  const ctx = model.ctxK * 1024
  return {
    id: model.alias,
    name: model.name,
    api: 'openai-completions',
    provider: providerIdFor(model.id),
    baseUrl: baseUrlFor(model),
    input: model.vision ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: ctx,
    // 输出上限取上下文的一半且不超过 8192：本地模型常见的安全取值
    maxTokens: Math.min(Math.floor(ctx / 2), 8192),
    compat: { maxTokensField: 'max_tokens' },
  }
}
