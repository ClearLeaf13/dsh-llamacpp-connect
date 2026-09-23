/**
 * dsh-llamacpp-connect — 把本地 llama.cpp 管理器的模型接入 DeepSeek Harness。
 *
 * 工作方式：
 *   1. 定位管理器数据目录，读出它维护的模型列表
 *   2. 每个模型注册为一个独立 provider，指向该模型的 llama-server 端口
 *   3. 选中未运行的模型时，先请管理器把它启动起来，再转发请求
 *
 * @module dsh-llamacpp-connect
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'

import { locateManager, type ManagerLocation } from './discovery.js'
import { parseModels, providerIdFor, type ManagerModel } from './config-store.js'
import { ControlClient } from './control-client.js'
import { ensureRunning, toPiModel } from './adapter.js'

export const name = 'dsh-llamacpp-connect'

/** 依赖的 DSH 服务；缺任一则不加载，避免半残注册 */
export const inject = ['llm']

/** host 与 client 之间的状态通道路径 */
export const STATUS_PATH = '/plugins/dsh-llamacpp-connect/status'

/** 同步触发路径（POST） */
export const SYNC_PATH = '/plugins/dsh-llamacpp-connect/sync'

/**
 * 本插件已注册的路由路径。
 *
 * 放在模块级而非 apply 内部：Cordis 的 HMR `Fiber._reload()` 会重新执行
 * `apply`（可能产生新的闭包），但模块实例是同一个。用它作为「注册前探测」
 * 的兜底依据，避免宿主路由表查询不可用时重复注册。
 */
const registeredRoutes = new Set<string>()

/** 路由响应的最小接口 —— 只用到 writeHead/end，避免依赖具体实现 */
interface RouteResponse {
  writeHead: (code: number, headers: Record<string, string>) => void
  end: (body?: string) => void
}

/** 统一的 JSON 响应写法 */
function sendJson(res: RouteResponse, code: number, payload: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** 插件配置 */
export interface Config {
  /** 手动指定管理器数据目录；留空则自动探测 */
  managerDir?: string
  /** 是否在选中未运行模型时自动启动；关闭则只报错 */
  autoStart: boolean
}

export const Config: z<Config> = z.object({
  managerDir: z.string().default(''),
  autoStart: z.boolean().default(true),
})

/** 当前已注册的 provider id，用于同步时先撤旧再登新 */
type Registration = {
  model: ManagerModel
  providerId: string
  dispose: () => void
}

/** 插件运行期状态，挂在 ctx 上供客户端配置页查询 */
export interface RuntimeState {
  location?: ManagerLocation
  models: ManagerModel[]
  skipped: Array<{ index: number; reason: string }>
  registrations: Map<string, Registration>
  controlApi: boolean
  lastSyncAt?: number
  lastError?: string
}

/**
 * 读取并解析管理器配置。
 *
 * 抽成独立函数便于客户端同步流程复用同一套逻辑。
 */
export async function loadModels(
  managerDir?: string,
): Promise<
  | { ok: true; location: ManagerLocation; models: ManagerModel[]; skipped: RuntimeState['skipped'] }
  | { ok: false; error: string }
> {
  const dirs = managerDir ? [managerDir] : undefined
  const location = await locateManager(dirs)
  if (!location) {
    return { ok: false, error: '未检测到 llama.cpp 管理器（找不到 models.json）' }
  }

  let raw: string
  try {
    raw = await readFile(location.modelsPath, 'utf8')
  } catch (e) {
    return { ok: false, error: `读取配置失败：${(e as Error).message}` }
  }

  const { models, skipped } = parseModels(raw)
  if (models.length === 0) {
    return {
      ok: false,
      error: skipped.length
        ? `配置里没有可用模型（${skipped[0]!.reason}）`
        : '管理器里还没有配置任何模型',
    }
  }

  return { ok: true, location, models, skipped }
}

export function apply(ctx: Context, config: Config): () => void {
  const state: RuntimeState = {
    models: [],
    skipped: [],
    registrations: new Map(),
    controlApi: false,
  }

  let client: ControlClient | undefined

  /** 撤销全部已注册的 provider */
  const unregisterAll = () => {
    for (const reg of state.registrations.values()) {
      try {
        reg.dispose()
      } catch (e) {
        ctx.logger?.warn?.(`dsh-llamacpp-connect: 撤销 ${reg.providerId} 失败`, e)
      }
    }
    state.registrations.clear()
  }

  /**
   * 同步：重读管理器配置，重建 provider 注册。
   *
   * 先全部撤销再重建，而不是增量 diff —— provider 的模型列表在 DSH 侧
   * 是快照语义，增量更新容易留下已删除模型的残影。
   */
  const sync = async (): Promise<{ ok: boolean; count: number; error?: string }> => {
    const loaded = await loadModels(config.managerDir || undefined)
    if (!loaded.ok) {
      state.lastError = loaded.error
      unregisterAll()
      state.models = []
      return { ok: false, count: 0, error: loaded.error }
    }

    state.location = loaded.location
    state.models = loaded.models
    state.skipped = loaded.skipped
    state.controlApi = Boolean(loaded.location.apiPort && loaded.location.apiToken)
    state.lastError = undefined
    client = new ControlClient(loaded.location)

    unregisterAll()

    const llm = ctx.llm as unknown as {
      registerAdapter?: (ids: string[], adapter: unknown) => () => void
    }

    if (typeof llm.registerAdapter !== 'function') {
      const msg = '宿主未提供 llm.registerAdapter，无法注册模型'
      state.lastError = msg
      ctx.logger?.error?.(`dsh-llamacpp-connect: ${msg}`)
      return { ok: false, count: 0, error: msg }
    }

    // 动态加载 peer，避免树外包静态 import 解析不到
    const { PiAiAdapter } = (await import('@deepseek-ai/dsh-llm-pi-ai')) as unknown as {
      PiAiAdapter: new (options: unknown) => unknown
    }

    for (const model of loaded.models) {
      const providerId = providerIdFor(model.id)
      try {
        const piModel = toPiModel(model)

        // 每个模型一个 provider：piProvider 的 models 只含它自己
        const piProvider = {
          id: providerId,
          name: model.name,
          models: [piModel],
          api: 'openai-completions',
        }

        const profile = {
          provider: providerId,
          displayName: model.name,
          piProvider,
          configuredMaxTokens: new Map(),
          modelErrors: new Map(),
        }

        const adapter = new PiAiAdapter({
          profiles: () => new Map([[providerId, profile]]),
          auth: { apiKey: { name: '本地 llama.cpp（无需密钥）', resolve: async () => undefined } },
          resolveApiKey: async () => 'local',
        })

        const dispose = llm.registerAdapter([providerId], adapter)
        state.registrations.set(providerId, { model, providerId, dispose })
      } catch (e) {
        ctx.logger?.warn?.(`dsh-llamacpp-connect: 注册 ${providerId} 失败`, e)
        state.lastError = `注册「${model.name}」失败：${(e as Error).message}`
      }
    }

    state.lastSyncAt = Date.now()
    ctx.logger?.info?.(
      `dsh-llamacpp-connect: 已同步 ${state.registrations.size} 个模型` +
        (state.controlApi ? '（控制接口可用）' : '（无控制接口，无法自动启动）'),
    )

    return { ok: true, count: state.registrations.size }
  }

  /**
   * 供适配器在请求前调用：确保目标模型可服务。
   *
   * 用闭包而非挂到 ctx 上 —— Cordis 的上下文是服务容器，
   * 只有经 provide 声明的 key 才允许赋值，随意挂属性会导致插件加载失败。
   */
  const ensureModelReady = (model: ManagerModel) => {
    if (!config.autoStart) return Promise.resolve({ ok: true, started: false })
    if (!client) return Promise.resolve({ ok: false, started: false, error: '控制客户端未初始化' })
    return ensureRunning(model, client)
  }

  /**
   * 组装状态路由的响应体。
   *
   * 定义在 ctx.inject 之前：虽然在柯里化回调里引用也不会出错（回调异步执行），
   * 但按依赖顺序排列更易读，也避免日后有人把回调改成同步时踩坑。
   */
  const buildStatusPayload = async () => {
    if (!state.location) {
      return {
        ok: false,
        installed: false,
        controlApi: false,
        models: [] as unknown[],
        skipped: state.skipped,
        lastError: state.lastError,
      }
    }

    // 运行状态来自管理器控制接口；拿不到就退化为「未运行」而不是谎报运行中
    const runningByPort: Record<number, boolean> = {}
    if (client?.available) {
      const st = await client.status()
      if (st.ok && st.models) {
        for (const m of st.models) runningByPort[m.port] = m.running
      }
    }

    return {
      ok: true,
      installed: true,
      managerDir: state.location.dir,
      controlApi: state.controlApi,
      models: state.models.map((m) => ({
        id: m.id,
        name: m.name,
        alias: m.alias,
        port: m.port,
        ctxK: m.ctxK,
        vision: m.vision,
        running: runningByPort[m.port] ?? false,
      })),
      skipped: state.skipped,
      lastSyncAt: state.lastSyncAt,
      lastError: state.lastError,
      statusPath: STATUS_PATH,
    }
  }

  /**
   * 注册 HTTP 路由，供配置页读取数据与触发同步。
   *
   * host 与 client 之间走同源 HTTP —— client 在网页里 fetch 这些路径。
   *
   * 关键：`ctx.webServer` 是**服务**，访问它必须通过 `ctx.inject([...])`
   * 拿到注入了该服务的子上下文。直接读 `ctx.webServer` 会抛
   * `cannot get property "webServer" without inject` 并导致插件加载失败。
   * 用 inject 同时获得优雅降级：宿主没有 webServer 服务时回调不执行，
   * provider 注册不受影响。
   *
   * **注册必须幂等**：Cordis 的 HMR `Fiber._reload()` 会在**同一个 fiber**
   * 上重新执行整个 `apply`。而宿主的路由表是全局的，上一轮注册的路由
   * （`_reload` 时上一轮的清理尚未完成）仍在表里，重复注册会抛
   * `webserver: duplicate exact route "..."`，进而让整个插件加载失败。
   *
   * 注意：实测「把 register 的 disposer 登记好」**解决不了**这个问题
   * （返回 disposer、包进 ctx.effect 都不行），因为重跑发生在清理之前。
   * 唯一可靠的做法是注册前先探测、已存在则跳过。
   */
  ctx.inject(['webServer'], (webCtx: unknown) => {
    const server = (
      webCtx as {
        webServer: {
          register: (r: unknown) => () => void
          exact?: { has?: (path: string) => boolean }
        }
      }
    ).webServer

    /**
     * 判断某路径是否已注册。
     *
     * 优先问宿主的路由表（`exact`），拿不到就回退到本模块自己记的集合 ——
     * `exact` 是宿主内部字段，没有类型声明，不能当作稳定的公开 API 依赖。
     */
    const alreadyRegistered = (path: string): boolean => {
      if (registeredRoutes.has(path)) return true
      try {
        return server.exact?.has?.(path) === true
      } catch {
        return false
      }
    }

    /** 注册一条路由；已存在则跳过，避免 HMR 重跑时撞车 */
    const registerOnce = (route: {
      kind: 'exact'
      path: string
      handler: (req: { method?: string }, res: RouteResponse) => unknown
    }): void => {
      if (alreadyRegistered(route.path)) return
      server.register(route)
      registeredRoutes.add(route.path)
    }

    // 状态查询
    registerOnce({
      kind: 'exact',
      path: STATUS_PATH,
      handler: async (req: { method?: string }, res: RouteResponse) => {
        if (req.method && req.method !== 'GET') {
          return sendJson(res, 405, { ok: false, error: '仅支持 GET' })
        }
        sendJson(res, 200, await buildStatusPayload())
      },
    })

    // 触发同步 —— 配置页的「同步模型」按钮打这里
    registerOnce({
      kind: 'exact',
      path: SYNC_PATH,
      handler: async (req: { method?: string }, res: RouteResponse) => {
        if (req.method && req.method !== 'POST') {
          return sendJson(res, 405, { ok: false, error: '仅支持 POST' })
        }
        const r = await sync()
        sendJson(res, r.ok ? 200 : 500, {
          ...r,
          // 同步完顺带回一份最新状态，省掉客户端再取一次
          state: await buildStatusPayload(),
        })
      },
    })
  })

  // 启动时同步一次；失败不抛出，插件加载不应因管理器缺失而失败
  void sync().catch((e) => {
    state.lastError = (e as Error).message
    ctx.logger?.warn?.('dsh-llamacpp-connect: 首次同步失败', e)
  })

  // 插件卸载时清理注册，避免残留 provider。
  //
  // 这里**返回** disposer 而不是调 ctx.effect：HMR `Fiber._reload()` 重跑
  // `apply` 时，外层 ctx 对应的 fiber 已失效，`ctx.effect` 会抛
  // `cannot create effect on inactive context`。而 apply 的返回值会被
  // Cordis 的 runner 直接收集（cordis/lib/index.js:1140/1068），
  // 不经过 fiber 活跃性检查，重跑时同样能正确登记。
  return () => {
    unregisterAll()
  }
}

export { parseModels, providerIdFor, baseUrlFor } from './config-store.js'
export { toPiModel, ensureRunning, portOpen, modelReady } from './adapter.js'
export { locateManager, candidateDirs } from './discovery.js'
export { ControlClient } from './control-client.js'
