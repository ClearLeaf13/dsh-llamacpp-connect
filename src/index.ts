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

export function apply(ctx: Context, config: Config): void {
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

  // 把同步能力与状态暴露到 ctx，供客户端配置页调用
  ctx.set?.('llamacppConnect', {
    sync,
    state,
    /** 供适配器在请求前调用：确保目标模型在运行 */
    ensureRunning: (model: ManagerModel) => {
      if (!config.autoStart) return Promise.resolve({ ok: true, started: false })
      if (!client) return Promise.resolve({ ok: false, started: false, error: '控制客户端未初始化' })
      return ensureRunning(model, client)
    },
  })

  // 启动时同步一次；失败不抛出，插件加载不应因管理器缺失而失败
  void sync().catch((e) => {
    state.lastError = (e as Error).message
    ctx.logger?.warn?.('dsh-llamacpp-connect: 首次同步失败', e)
  })

  // 插件卸载时清理注册，避免残留 provider
  ctx.effect?.(() => () => {
    unregisterAll()
  })
}

export { parseModels, providerIdFor, baseUrlFor } from './config-store.js'
export { toPiModel, ensureRunning, portOpen, modelReady } from './adapter.js'
export { locateManager, candidateDirs } from './discovery.js'
export { ControlClient } from './control-client.js'
