/**
 * 调用本地 LLM 管理器（llm-manager）的控制 API。
 *
 * 管理器在 `127.0.0.1:<port>` 暴露三个端点，全部需要
 * `Authorization: Bearer <token>`：
 *
 * | 端点 | 用途 |
 * |---|---|
 * | `GET /status` | 各模型运行状态 |
 * | `POST /start` | 启动模型 |
 * | `POST /stop` | 停止模型 |
 *
 * 本模块只负责「说话」，不判断该不该启动 —— 那是调用方的决策。
 *
 * @module dsh-local-llm-connect/control-client
 */

import type { ManagerLocation } from './discovery.js'

/** 单次请求超时（毫秒）。启动模型本身可能耗时数分钟，见 startModel 的独立超时 */
const DEFAULT_TIMEOUT_MS = 5_000

export interface ModelStatus {
  id: string
  name: string
  alias: string
  port: number
  running: boolean
}

export interface StatusResult {
  ok: boolean
  models?: ModelStatus[]
  anyRunning?: boolean
  current?: string | null
  starting?: boolean
  error?: string
}

export interface ActionResult {
  ok: boolean
  port?: number
  pid?: number
  error?: string
}

/** 把错误归一成可读文本，避免把底层异常直接抛给界面 */
function describeError(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'AbortError') return '请求超时'

    // undici 把网络层错误包在 cause 上，顶层只给出 'fetch failed'，
    // 因此要往下挖一层才能拿到 ECONNREFUSED 这类有意义的码
    const codes = new Set<string>()
    const collect = (err: unknown, depth = 0): void => {
      if (!err || typeof err !== 'object' || depth > 4) return
      const code = (err as NodeJS.ErrnoException).code
      if (typeof code === 'string') codes.add(code)
      collect((err as { cause?: unknown }).cause, depth + 1)
    }
    collect(e)

    if (codes.has('ECONNREFUSED')) {
      return '管理器控制接口未响应（管理器可能已退出）'
    }
    if (codes.has('ECONNRESET')) return '与管理器的连接被重置'

    // 顶层信息无意义时不把它当答案返回
    if (e.message && e.message !== 'fetch failed') return e.message
    return '请求失败（无法连接管理器控制接口）'
  }
  return String(e)
}

export class ControlClient {
  constructor(private readonly loc: ManagerLocation) {}

  /** 端口与令牌是否齐备 */
  get available(): boolean {
    return Boolean(this.loc.apiPort && this.loc.apiToken)
  }

  private get origin(): string {
    return `http://127.0.0.1:${this.loc.apiPort}`
  }

  private async call(
    path: string,
    init: RequestInit = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.available) {
      throw new Error('控制接口不可用（管理器未运行或版本过旧）')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${this.origin}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.loc.apiToken}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
      })
      const text = await res.text()
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`响应不是 JSON（HTTP ${res.status}）`)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 查询各模型运行状态 */
  async status(): Promise<StatusResult> {
    try {
      const raw = (await this.call('/status')) as StatusResult
      return { ...raw, ok: raw?.ok !== false }
    } catch (e) {
      return { ok: false, error: describeError(e) }
    }
  }

  /**
   * 启动模型。
   *
   * 超时给足 5 分钟：管理器要 spawn 进程并加载 gguf，大模型在机械盘上
   * 首次加载可能远超一分钟，超时太短会把正常启动误判为失败。
   */
  async start(id: string, ctxK?: number): Promise<ActionResult> {
    try {
      const body = JSON.stringify(ctxK === undefined ? { id } : { id, ctxK })
      const raw = (await this.call('/start', { method: 'POST', body }, 300_000)) as ActionResult
      return raw?.ok ? raw : { ok: false, error: raw?.error ?? '启动被拒绝' }
    } catch (e) {
      return { ok: false, error: describeError(e) }
    }
  }

  /** 停止当前运行的模型 */
  async stop(): Promise<ActionResult> {
    try {
      const raw = (await this.call('/stop', { method: 'POST', body: '{}' })) as ActionResult
      return raw?.ok ? raw : { ok: false, error: raw?.error ?? '停止被拒绝' }
    } catch (e) {
      return { ok: false, error: describeError(e) }
    }
  }
}
