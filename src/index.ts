/**
 * dsh-llamacpp-connect — 把本地 llama.cpp 管理器的模型接入 DeepSeek Harness。
 *
 * host 半职责：
 *   1. 定位管理器数据目录，读出它维护的模型列表
 *   2. 每个模型注册为一个独立 provider，指向该模型的 llama-server 端口
 *   3. 注册两个同源 HTTP 路由，供 client 半读取状态、触发同步
 *
 * 设置面板（主设置 → 左侧导航「llama.cpp Connect」）完全由 client 半通过
 * DSH 官方的 `settings.section` slot 注册，host 半不参与 —— 这是官方推荐的
 * 挂载点（`@deepseek-ai/dsh-client-ui-settings-general` 声明，注册即可见）。
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

/** 一次同步的结果 */
export interface SyncResult {
  ok: boolean
  count: number
  error?: string
}

/**
 * 当前「活跃代」的对外处理逻辑。
 *
 * 路由在一个进程内只注册一次，但它的处理器**不能闭包捕获某一次 apply 的 ctx**：
 * HMR / patch 热重载会重新执行 `apply`，上一代的 ctx 随即失效。若处理器仍指向
 * 旧闭包，访问 `ctx.llm` 就会抛：
 *
 *   cannot get required service "llm" in inactive context
 *   at sync (.../dsh-llamacpp-connect/lib/index.js)
 *   at async Object.handler (.../lib/index.js)   ← /sync 路由处理器
 *
 * （这是真实日志里出现过的堆栈。同理，`ctx.inject` / `ctx.effect` 在失效 ctx 上
 * 也会抛 `cannot create effect on inactive context`。）
 *
 * 因此处理器统一从 `live` 取**当前代**的实现：每次 apply 发布自己，卸载时清空。
 * 插件被停用后处理器明确返回 503，而不是去碰已经死掉的 ctx。
 */
interface LiveGeneration {
  sync: () => Promise<SyncResult>
  status: () => Promise<unknown>
}

let live: LiveGeneration | undefined

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

/** 插件运行期状态，供状态路由组装响应体 */
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
   * 单次同步的实现：重读管理器配置，重建 provider 注册。
   *
   * 先全部撤销再重建，而不是增量 diff —— provider 的模型列表在 DSH 侧
   * 是快照语义，增量更新容易留下已删除模型的残影。
   *
   * 顺序上刻意把「解析适配器类」放在 `unregisterAll()` **之前**：解析失败时
   * 保留已有 provider，而不是拆掉旧的又装不上新的、让模型全部消失。
   */
  const runSync = async (): Promise<SyncResult> => {
    const loaded = await loadModels(config.managerDir || undefined)
    if (!loaded.ok) {
      state.lastError = loaded.error
      unregisterAll()
      state.models = []
      return { ok: false, count: 0, error: loaded.error }
    }

    const llm = ctx.llm as unknown as {
      registerAdapter?: (ids: string[], adapter: unknown) => () => void
    }

    if (typeof llm.registerAdapter !== 'function') {
      const msg = '宿主未提供 llm.registerAdapter，无法注册模型'
      state.lastError = msg
      ctx.logger?.error?.(`dsh-llamacpp-connect: ${msg}`)
      return { ok: false, count: 0, error: msg }
    }

    // 动态加载 peer（静态 import 在树外产物里可能解析不到）。失败时给出明确
    // 原因，而不是让它冒泡到最外层、只剩一句「首次同步失败 {}」。
    let PiAiAdapter: new (options: unknown) => unknown
    let createProvider: (spec: unknown) => unknown
    let openAICompletionsApi: () => unknown
    try {
      ;({ PiAiAdapter } = (await import('@deepseek-ai/dsh-llm-pi-ai')) as unknown as {
        PiAiAdapter: new (options: unknown) => unknown
      })
      ;({ createProvider } = (await import('@earendil-works/pi-ai')) as unknown as {
        createProvider: (spec: unknown) => unknown
      })
      ;({ openAICompletionsApi } = (
        await import('@earendil-works/pi-ai/api/openai-completions.lazy')
      ) as unknown as { openAICompletionsApi: () => unknown })
    } catch (e) {
      const msg =
        '无法加载 pi-ai 运行时依赖（@deepseek-ai/dsh-llm-pi-ai、@earendil-works/pi-ai，' +
        `宿主必须能解析它们，请确认随 profile 一起安装）：${(e as Error)?.message ?? String(e)}`
      state.lastError = msg
      ctx.logger?.error?.(`dsh-llamacpp-connect: ${msg}`)
      return { ok: false, count: 0, error: msg }
    }

    state.location = loaded.location
    state.models = loaded.models
    state.skipped = loaded.skipped
    state.controlApi = Boolean(loaded.location.apiPort && loaded.location.apiToken)
    state.lastError = undefined
    client = new ControlClient(loaded.location)

    unregisterAll()

    for (const model of loaded.models) {
      const providerId = providerIdFor(model.id)
      try {
        const piModel = toPiModel(model)

        /**
         * provider 必须用 pi-ai 的 `createProvider()` 构造。
         *
         * 手搓 `{ id, name, models, api: 'openai-completions' }` 是不行的：`createProvider`
         * 返回的是带 `auth / getModels / refreshModels / filterModels / stream / streamSimple`
         * 的完整 provider，而 `PiAiAdapter` 内部用
         * `snapshot.models.setProvider(profile.piProvider)` 建模型目录、
         * `snapshot.models.getModels(provider)` 取模型。
         *
         * 手搓对象会被这个目录拒收 —— `adapter.listModels()` 返回**空数组**，
         * 于是模型选择列表里看不到任何模型（同步本身却是「成功」的）。
         * 对照实测：手搓 → 0 条；createProvider → 1 条。
         *
         * `api` 必须是 `openAICompletionsApi()` 返回的 **Api 对象**，不是协议名字符串。
         */
        const piProvider = createProvider({
          id: providerId,
          name: model.name,
          baseUrl: piModel.baseUrl,
          auth: {
            apiKey: { name: '本地 llama.cpp（无需密钥）', resolve: async () => undefined },
          },
          models: [piModel],
          api: openAICompletionsApi(),
        })

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
   * 串行化的同步入口（启动时与 POST /sync 共用同一条队列）。
   *
   * 两者可能并发：都会先 `unregisterAll()` 再 `registerAdapter`，而
   * `llm.registerAdapter` 对已注册的 provider 会抛 `DUPLICATE_ADAPTER`
   * （dsh-llm/lib/index.js:1810）。失败一方的本地 registrations 与真实注册表
   * 不一致，后续 `unregisterAll()` 清不到那些 provider —— 表现为模型凭空消失。
   * 用一条 promise 链把同步排成队列，消除交错。
   */
  let syncTail: Promise<unknown> = Promise.resolve()
  const sync = (): Promise<SyncResult> => {
    const run = syncTail.then(() => runSync())
    syncTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
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
   * 注册 HTTP 路由，供 client 半读取数据与触发同步。
   *
   * 关键：`ctx.webServer` 是**服务**，访问它必须通过 `ctx.inject([...])`
   * 拿到注入了该服务的子上下文。直接读 `ctx.webServer` 会抛
   * `cannot get property "webServer" without inject` 并导致插件加载失败。
   * 用 inject 同时获得优雅降级：宿主没有 webServer 服务时回调不执行，
   * provider 注册不受影响。
   *
   * **注册必须幂等**：Cordis 的 HMR `Fiber._reload()` 会在**同一个 fiber**
   * 上重新执行整个 `apply`，宿主路由表是全局的，重复注册会抛
   * `webserver: duplicate exact route "..."`。注册前先探测、已存在则跳过。
   */
  // 发布本代逻辑。处理器通过 live 取「当前代」，而不是闭包捕获本次 apply 的 ctx
  // —— 否则 HMR 重载后旧处理器会去访问已失效的 ctx（见 LiveGeneration 注释）。
  live = { sync, status: buildStatusPayload }

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
     * 路由是否已在本宿主实例上注册。
     *
     * **优先问宿主的路由表**（权威来源），只有拿不到 `exact` 时才回退到本模块
     * 自己的集合。顺序不能反：模块级集合会跨 HMR 代际残留，若它短路在前，
     * 一旦宿主路由表被重建，这里会永远返回「已注册」而**静默地不再注册路由**。
     */
    const alreadyRegistered = (path: string): boolean => {
      try {
        const probed = server.exact?.has?.(path)
        if (typeof probed === 'boolean') return probed
      } catch {
        /* 该字段不可用或抛错：回退到本地集合 */
      }
      return registeredRoutes.has(path)
    }

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
        const current = live
        if (!current) {
          return sendJson(res, 503, {
            ok: false,
            installed: false,
            controlApi: false,
            models: [],
            skipped: [],
            lastError: '插件未就绪或已卸载',
          })
        }
        sendJson(res, 200, await current.status())
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
        const current = live
        if (!current) {
          return sendJson(res, 503, {
            ok: false,
            count: 0,
            error: '插件未就绪或已卸载',
            state: null,
          })
        }
        const r = await current.sync()
        sendJson(res, r.ok ? 200 : 500, {
          ...r,
          // 同步完顺带回一份最新状态，省掉客户端再取一次
          state: await current.status(),
        })
      },
    })
  })

  // 启动时同步一次；失败不抛出，插件加载不应因管理器缺失而失败。
  //
  // 日志必须显式带上 message 与首帧堆栈：只把 error 对象交给 logger 会被格式化
  // 成 `{}`（Error 的属性不可枚举），真因曾因此长期不可见。
  void sync().catch((e) => {
    const err = e as Error
    const detail = err?.message ?? String(e)
    state.lastError = detail
    const frames = err?.stack?.split('\n').slice(0, 4).join('\n')
    ctx.logger?.warn?.(
      `dsh-llamacpp-connect: 首次同步失败: ${detail}` + (frames ? `\n${frames}` : ''),
    )
  })

  // 插件卸载时清理注册，避免残留 provider。
  //
  // 这里**返回** disposer 而不是调 ctx.effect：HMR `Fiber._reload()` 重跑
  // `apply` 时，外层 ctx 对应的 fiber 已失效，`ctx.effect` 会抛
  // `cannot create effect on inactive context`。而 apply 的返回值会被
  // Cordis 的 runner 直接收集（cordis/lib/index.js:1140/1068），
  // 不经过 fiber 活跃性检查，重跑时同样能正确登记。
  return () => {
    // 只有自己仍是「当前代」时才清空 live，避免把后来者的代一起清掉。
    // 清空后路由处理器会明确返回 503，而不是访问已失效的 ctx。
    if (live?.sync === sync) live = undefined
    unregisterAll()
  }
}

export { parseModels, providerIdFor, baseUrlFor } from './config-store.js'
export { toPiModel, ensureRunning, portOpen, modelReady } from './adapter.js'
export { locateManager, candidateDirs } from './discovery.js'
export { ControlClient } from './control-client.js'
