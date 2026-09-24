import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { toPiModel } from '../src/adapter.js'
import { providerIdFor, type ManagerModel } from '../src/config-store.js'

// 真实运行时依赖（本仓库 node_modules 已安装，用于复现宿主的模型目录行为）
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

/**
 * 防回归：模型必须能被模型选择列表枚举出来。
 *
 * 真实故障：同步「成功」了，但模型选择里一个模型都没有。
 *
 * 根因是 provider 的构造方式。`PiAiAdapter` 内部这样建模型目录：
 *
 *   const models = createModels(this.config.auth)
 *   for (const profile of profiles.values())
 *     if (profile.piProvider !== void 0) models.setProvider(profile.piProvider)
 *
 * 而模型列表走 `snapshot.models.getModels(provider)`
 * （宿主侧入口见 @deepseek-ai/dsh-llm/lib/index.js:2018 的
 * `this.registration(provider).adapter.listModels(provider)`）。
 *
 * 之前 `piProvider` 是手搓的 `{ id, name, models, api: 'openai-completions' }`：
 * 它缺 `auth / getModels / stream` 等成员，会被 `Models` 集合拒收 ——
 * `listModels()` 返回**空数组**，于是模型选择里什么都看不到。
 *
 * 正确做法（官方 dsh-llm-pi-ai 与 dsh-workbuddy-connect 都如此）：
 * `createProvider({ id, name, baseUrl, auth, models, api: openAICompletionsApi() })`
 * —— `api` 必须是 `openAICompletionsApi()` 返回的 **Api 对象**，不是协议名字符串。
 */
const MODEL: ManagerModel = {
  id: 'qwen3-8b-demo',
  name: 'Qwen3 8B Demo',
  alias: 'qwen3-8b-demo',
  port: 8080,
  ctxK: 32,
  vision: false,
}

const PROVIDER_ID = providerIdFor(MODEL.id)

function adapterWith(piProvider: unknown) {
  const profile = {
    provider: PROVIDER_ID,
    displayName: MODEL.name,
    piProvider,
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
  }
  return new PiAiAdapter({
    profiles: () => new Map([[PROVIDER_ID, profile]]),
    auth: { apiKey: { name: '本地 LLM（无需密钥）', resolve: async () => undefined } },
    resolveApiKey: async () => 'local',
  })
}

describe('模型目录：provider 必须用 pi-ai 的 createProvider 构造', () => {
  it('createProvider + openAICompletionsApi() 时 listModels 能枚举出模型', async () => {
    const piModel = toPiModel(MODEL)
    const adapter = adapterWith(
      createProvider({
        id: PROVIDER_ID,
        name: MODEL.name,
        baseUrl: piModel.baseUrl,
        auth: { apiKey: { name: '本地 LLM（无需密钥）', resolve: async () => undefined } },
        models: [piModel],
        api: openAICompletionsApi(),
      }),
    )

    const list = await adapter.listModels(PROVIDER_ID)
    expect(list.length, 'listModels 必须能列出模型，否则模型选择里看不到').toBeGreaterThan(0)
    expect(list[0].id).toBe(piModel.id)
    expect(list[0].provider).toBe(PROVIDER_ID)
    expect(list[0].name).toBeTruthy()
  })

  it('负对照：手搓 provider（api 是字符串）会让 listModels 返回空 —— 这正是原 bug', async () => {
    // 这条断言确保上面的测试真的能捕获该缺陷：一旦未来有人把它改回手搓形式，
    // 上一条测试必然失败，而这条会说明原因。
    const adapter = adapterWith({
      id: PROVIDER_ID,
      name: MODEL.name,
      models: [toPiModel(MODEL)],
      api: 'openai-completions',
    })
    expect(await adapter.listModels(PROVIDER_ID)).toEqual([])
  })

  it('src/index.ts 使用 createProvider + openAICompletionsApi()，不手搓 provider', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).toMatch(/createProvider\(/)
    expect(code).toMatch(/openAICompletionsApi\(\)/)
    // 手搓形式：把协议名当字符串塞进 provider
    expect(code).not.toMatch(/api:\s*'openai-completions'/)
  })
})
