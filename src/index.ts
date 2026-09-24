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
import { toPiModel } from './adapter.js'

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
}

export const Config: z<Config> = z.object({
  managerDir: z.string().default(''),
})

/**
 * 重新评估「哪些模型正在运行」的间隔。
 *
 * 模型选择列表只包含运行中的模型，因此运行状态一变列表就要跟上 ——
 * 15 秒是「启动/停止模型后基本无感」与「不频繁打扰管理器」之间的折中。
 */
const POLL_INTERVAL_MS = 15_000

/** 当前已注册的 provider id，用于同步时先撤旧再登新 */
type Registration = {
  model: ManagerModel
  providerId: string
  dispose: () => void
}

/** 插件运行期状态，供状态路由组装响应体 */
export interface RuntimeState {
  location?: ManagerLocation
  /**
   * **正在运行**的模型 —— 与模型选择列表严格一致（未运行的不出现）。
   *
   * 数据源是管理器控制接口的 `models[].running`；判定不了时这里是空数组。
   */
  models: ManagerModel[]
  /** `models.json` 里的模型总数，用于说明「为什么有些模型不在列表里」 */
  totalModels: number
  /** 当前判定为运行的端口集合；`undefined` 表示无法判定 */
  runningPorts?: Set<number>
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

/**
 * 与 `dsh-llm-pi-ai` 官方归一化一致的默认值。
 *
 * 出处：该包 profile schema 的 `.default(...)`，以及 `resolveProfiles()` 里的
 * `?? 3e5` / `?? 20971520` / `?? 4194304` / `?? 1048576`。
 */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 4 * 1024 * 1024
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/**
 * 「无需密钥」provider 的 auth 声明。
 *
 * 逐字复刻 `dsh-llm-pi-ai` 内部的 `harnessApiKeyAuth()` —— 该函数**没有导出**
 * （它的导出只有 `Config / PiAiAdapter / apply / inject / name / recordKeyFor /
 * supportedProtocols`），所以只能照抄形状：
 *
 *   resolve: ({ credential }) => Promise.resolve({
 *     auth: credential?.key === undefined ? {} : { apiKey: credential.key },
 *     source: name,
 *   })
 *
 * **关键：`resolve` 必须返回一个对象，绝不能返回 `undefined`。**
 * pi-ai 的 `Models.applyAuth()`（@earendil-works/pi-ai/dist/models.js:358-367）
 * 只判断解析结果是否为真值：
 *
 *   const resolution = await this.getAuth(model, {...})
 *   if (!resolution) throw new ModelsError('auth', `Provider is not configured: ${model.provider}`)
 *
 * 我们原先写的是 `resolve: async () => undefined`，于是**请求一发出就**抛
 * `Provider is not configured: <provider>`（请求根本没到上游）。
 * 官方形状在「没有凭据」时返回 `{ auth: {} }`，依然通过这道判断 ——
 * 本地 llama.cpp 不需要密钥，空 auth 正合适。
 *
 * **用法必须嵌在 `auth.apiKey` 下**（官方 `routeAuth()` 即
 * `{ apiKey: harnessApiKeyAuth(name) }`）。`resolveProviderAuth()` 的第一条分支
 * 判的是 `provider.auth.apiKey` 是否存在 —— 少嵌这一层，它就成了 `undefined`，
 * 于是既不解析覆盖的 key、也拿不到环境凭据，最终仍抛 `Provider is not configured`。
 */
export function keylessApiKeyAuth(name: string): {
  name: string
  resolve: (context: {
    credential?: { key?: string }
  }) => Promise<{ auth: { apiKey?: string }; source: string }>
} {
  return {
    name,
    resolve: ({ credential }) =>
      Promise.resolve({
        auth: credential?.key === undefined ? {} : { apiKey: credential.key },
        source: name,
      }),
  }
}

/**
 * 构造一个 pi-ai **profile**。
 *
 * 我们是**手搓 profile** 直接交给 `PiAiAdapter({ profiles })`，因此绕过了
 * `dsh-llm-pi-ai` 的 `resolveProfiles()` 归一化（它没有导出，无法复用）。
 * 而 stream 路径会**直接读取**下列字段、没有兜底：
 *
 * | 字段 | 读取处 | 缺失后果 |
 * |---|---|---|
 * | `streamIdleTimeoutMs` | `dsh-llm-pi-ai:1865` → `idleWatchdog()` | 抛 `idleWatchdog timeoutMs must be a positive finite number no greater than 2147483647` |
 * | `maxRequestImageBytes` / `requestImagePixelBudget` / `requestImageMaxBytes` | `:1885-1888` 图片策略 | 图片处理拿到 `undefined` |
 * | `retryPolicy` | `:2567` `registrationFacts()` | 注册信息缺重试策略 |
 *
 * 其余字段（`thinkingBudgets` / `cacheRetention` / `transport` / `timeoutMs` …）
 * 在 `profileOptions()` 里都有 `=== void 0` 兜底，可以不传。
 *
 * @param options.resolveRetryPolicy - 从 `@deepseek-ai/dsh-llm` 动态引入的归一化函数
 *   （`dsh-llm-pi-ai` 用它把 `undefined` 归一成一个合法的默认策略）
 */
export function buildAdapterProfile(options: {
  provider: string
  displayName: string
  piProvider: unknown
  resolveRetryPolicy: (policy: unknown, label: string) => unknown
}): Record<string, unknown> {
  const { provider, displayName, piProvider, resolveRetryPolicy } = options
  return {
    provider,
    displayName,
    piProvider,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    retryPolicy: resolveRetryPolicy(undefined, `dsh-llamacpp-connect: provider "${provider}" retryPolicy`),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
  }
}

/**
 * 插件入口。
 *
 * **必须是箭头函数，不能写成 `export function apply(...)`。**
 *
 * cordis 用 `isConstructor(callback)` 区分「类式插件」和「函数式插件」：
 *
 *   function isConstructor(func) {
 *     if (!func.prototype) return false   // 箭头函数没有 prototype
 *     return true                          // 普通函数有
 *   }
 *
 * 普通函数会被判定为构造函数，于是 cordis 执行 `new callback(ctx, config)`，
 * 并且只收集 `instance[symbols.init]()` —— **本函数 return 出去的 disposer
 * 会被直接丢弃**。副作用照常发生，所以功能看起来正常，但插件卸载时永远不做
 * 清理：轮询定时器泄漏、适配器不会被撤销（已停掉的模型可能残留在模型选择里）。
 *
 * 箭头函数没有 prototype，cordis 会走 `callback(ctx, config)` 分支，并把返回值
 * `collect` 成 disposer（cordis/lib/index.js:1136-1142）。
 * 回归测试锁定了这一点（`apply.prototype === undefined`）。
 */
export const apply = (ctx: Context, config: Config): (() => void) => {
  const state: RuntimeState = {
    models: [],
    totalModels: 0,
    skipped: [],
    registrations: new Map(),
    controlApi: false,
  }

  let client: ControlClient | undefined

  /**
   * 按名字取一个**可选**服务。
   *
   * 用 `ctx.get(name)` 而不是 `ctx.attachments`：后者在服务未注入时会抛
   * `cannot get property "attachments" without inject`，而 `get` 在服务缺失时
   * 返回 undefined —— 这正是我们要的降级行为（官方 `dsh-llm-pi-ai` 也是这么取的，
   * 它顶层 `inject` 同样只有 `['llm']`）。
   */
  const ctxGet = (name: string): unknown => {
    try {
      return (ctx as unknown as { get?: (n: string) => unknown }).get?.(name)
    } catch {
      return undefined
    }
  }

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
   * 已注册集合的签名（`provider@端口`，排序后拼接）。
   *
   * 用来实现「运行集合没变就跳过重注册」：否则每 15 秒轮询都会拆装一遍适配器，
   * 正在进行的请求会被打断。签名含端口，所以重配端口也算变化。
   *
   * 签名始终由**实际注册成功**的模型算出，而不是期望集合 ——
   * 某个模型注册失败时两者不同，下一轮轮询就会自动重试。
   */
  const signatureOf = (models: ManagerModel[]): string =>
    models
      .map((m) => `${providerIdFor(m.id)}@${m.port}`)
      .sort()
      .join('|')

  let registeredSignature = ''

  /**
   * 单次同步的实现：重读管理器配置，按运行状态重建 provider 注册。
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
    let resolveRetryPolicy: (policy: unknown, label: string) => unknown
    let resolveImageAttachmentAccess: (
      attachments: unknown,
      mapHostPath: (hostPath: string) => unknown,
      ref: unknown,
    ) => unknown
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
      ;({ resolveRetryPolicy, resolveImageAttachmentAccess } = (await import(
        '@deepseek-ai/dsh-llm'
      )) as unknown as {
        resolveRetryPolicy: (policy: unknown, label: string) => unknown
        resolveImageAttachmentAccess: (
          attachments: unknown,
          mapHostPath: (hostPath: string) => unknown,
          ref: unknown,
        ) => unknown
      })
    } catch (e) {
      const msg =
        '无法加载 pi-ai 运行时依赖（@deepseek-ai/dsh-llm-pi-ai、@deepseek-ai/dsh-llm、' +
        `@earendil-works/pi-ai，宿主必须能解析它们，请确认随 profile 一起安装）：${
          (e as Error)?.message ?? String(e)
        }`
      state.lastError = msg
      ctx.logger?.error?.(`dsh-llamacpp-connect: ${msg}`)
      return { ok: false, count: 0, error: msg }
    }

    state.location = loaded.location
    state.totalModels = loaded.models.length
    state.skipped = loaded.skipped
    state.lastError = undefined
    client = new ControlClient(loaded.location)
    state.controlApi = client.available

    /**
     * 「正在运行」是模型进入选择列表的**唯一**依据。
     *
     * 权威来源是管理器控制接口的 `models[].running`（按端口索引）。
     * 判定不了时 —— 管理器没运行、版本过旧没有控制接口、或接口无响应 ——
     * **一个也不列**：宁可列表为空，也不让人选到跑不通的模型。
     */
    let ports: Set<number> | undefined
    if (client.available) {
      const st = await client.status()
      if (st.ok && st.models) ports = new Set(st.models.filter((m) => m.running).map((m) => m.port))
    }
    state.runningPorts = ports

    if (ports === undefined) {
      const msg = client.available
        ? '无法读取管理器运行状态（控制接口无响应），暂时不提供模型'
        : '无法判定运行状态：管理器未运行，或其版本过低没有控制接口 —— 暂时不提供模型'
      state.models = []
      unregisterAll()
      registeredSignature = ''
      state.lastError = msg
      ctx.logger?.warn?.(`dsh-llamacpp-connect: ${msg}`)
      return { ok: false, count: 0, error: msg }
    }

    // 只保留正在运行的模型。不写死任何模型 id：以后新增模型自动适用同一条规则。
    const running = loaded.models.filter((m) => ports.has(m.port))
    state.models = running

    if (signatureOf(running) === registeredSignature) {
      // 运行集合没有变化：保持现有注册，避免每轮轮询都打断进行中的请求
      state.lastSyncAt = Date.now()
      return { ok: true, count: state.registrations.size }
    }

    unregisterAll()

    for (const model of running) {
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
          // 必须是官方 harnessApiKeyAuth 的形状 —— 注意**要嵌在 apiKey 键下**
          // （官方 routeAuth() 就是 `{ apiKey: harnessApiKeyAuth(name) }`）。
          // 直接把它当 auth 会让 provider.auth.apiKey 为 undefined，
          // pi-ai 的 applyAuth() 随即抛 `Provider is not configured: <provider>`。
          auth: { apiKey: keylessApiKeyAuth(model.name) },
          models: [piModel],
          api: openAICompletionsApi(),
        })

        const profile = buildAdapterProfile({
          provider: providerId,
          displayName: model.name,
          piProvider,
          resolveRetryPolicy,
        })

        /**
         * adapter 选项照官方 `dsh-llm-pi-ai` 的构造补全。
         *
         * 其中 `resolveAttachments` **必须提供**：消息里带图片时，pi-ai 会调
         * `this.config.resolveAttachments?.()`，拿不到就抛
         *   pi-ai image input requires the durable attachment service
         * （dsh-llm-pi-ai:1870-1871）—— 图片上传后必然踩到。
         *
         * 附件与 fs 服务用 `ctx.get(...)` 取（官方也是这么写的，且它顶层
         * `inject` 同样只有 `['llm']`）：`get` 在服务缺失时返回 undefined，
         * 不会像属性访问那样抛 `without inject`。
         */
        const adapter = new PiAiAdapter({
          profiles: () => new Map([[providerId, profile]]),
          auth: { apiKey: { name: '本地 llama.cpp（无需密钥）', resolve: async () => undefined } },
          resolveApiKey: async () => 'local',
          resolveAttachments: () => ctxGet('attachments'),
          resolveImageAccess: (attachments: unknown, ref: unknown) =>
            resolveImageAttachmentAccess(
              attachments,
              (hostPath) => (ctxGet('fs') as { processPathFromHostPath?: (p: string) => unknown } | undefined)?.processPathFromHostPath?.(hostPath),
              ref,
            ),
          onReplayDegrade: ({
            provider,
            model: modelId,
            reason,
          }: {
            provider: string
            model: string
            reason: string
          }) => {
            ctx.logger?.warn?.(
              `dsh-llamacpp-connect: 历史消息中不可用的重放状态（${provider}/${modelId}），` +
                `该消息将以 provider 中立内容发送：${reason}`,
            )
          },
        })

        const dispose = llm.registerAdapter([providerId], adapter)
        state.registrations.set(providerId, { model, providerId, dispose })
      } catch (e) {
        ctx.logger?.warn?.(`dsh-llamacpp-connect: 注册 ${providerId} 失败`, e)
        state.lastError = `注册「${model.name}」失败：${(e as Error).message}`
      }
    }

    // 用**实际注册成功**的集合回填签名：有注册失败时签名与期望不同，
    // 下一轮轮询会自动重试，而不会因为「签名已匹配」而永远跳过。
    registeredSignature = signatureOf([...state.registrations.values()].map((r) => r.model))

    state.lastSyncAt = Date.now()
    ctx.logger?.info?.(
      `dsh-llamacpp-connect: 运行中 ${state.registrations.size} / 共 ${state.totalModels} 个模型` +
        (state.registrations.size < running.length ? '（部分注册失败）' : ''),
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
   * 组装状态路由的响应体。
   *
   * 数据全部取自 `state`，不在这里额外请求管理器 —— 卡片显示的模型集合必须与
   * 模型选择列表**完全一致**（都来自最近一次运行状态评估）。运行状态由轮询刷新，
   * 或由「同步模型」按钮立即刷新。
   */
  const buildStatusPayload = async () => {
    const running = state.models
    return {
      ok: Boolean(state.location),
      installed: Boolean(state.location),
      managerDir: state.location?.dir,
      controlApi: state.controlApi,
      // 只有运行中的模型（`running` 恒为 true —— 未运行的压根不在这个列表里）
      models: running.map((m) => ({
        id: m.id,
        name: m.name,
        alias: m.alias,
        port: m.port,
        ctxK: m.ctxK,
        vision: m.vision,
        running: true,
      })),
      runningCount: running.length,
      totalCount: state.totalModels,
      skipped: state.skipped,
      lastSyncAt: state.lastSyncAt,
      lastError: state.lastError,
      statusPath: STATUS_PATH,
      pollIntervalMs: POLL_INTERVAL_MS,
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

  /**
   * 定期重新评估运行状态：你在管理器里启动/停止模型后，模型选择列表会自动跟上，
   * 不需要手动点同步。
   *
   * 用自建 timer 而非 `ctx.setInterval` —— HMR 重载时 ctx 可能已经失效，
   * `ctx.setInterval` 会抛 `cannot create effect on inactive context`；
   * 自建 timer 在返回的 disposer 里显式清理，跨代际是安全的。
   *
   * 轮询走的就是那条串行队列，因此不会与「同步模型」按钮、启动同步互相交错。
   */
  const pollTimer = setInterval(() => {
    void sync().catch((e) => {
      // 轮询失败只记日志：管理器暂时不可达不该影响插件继续提供服务
      ctx.logger?.warn?.(
        `dsh-llamacpp-connect: 轮询失败: ${(e as Error)?.message ?? String(e)}`,
      )
    })
  }, POLL_INTERVAL_MS)

  // 别让一个轮询定时器拖住宿主进程退出
  ;(pollTimer as unknown as { unref?: () => void }).unref?.()

  // 插件卸载时清理注册与定时器，避免残留 provider 和后台轮询。
  //
  // 这里**返回** disposer 而不是调 ctx.effect：HMR `Fiber._reload()` 重跑
  // `apply` 时，外层 ctx 对应的 fiber 已失效，`ctx.effect` 会抛
  // `cannot create effect on inactive context`。而 apply 的返回值会被
  // Cordis 的 runner 直接收集（cordis/lib/index.js:1140/1068），
  // 不经过 fiber 活跃性检查，重跑时同样能正确登记。
  return () => {
    clearInterval(pollTimer)
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
