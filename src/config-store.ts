/**
 * 解析管理器维护的模型配置。
 *
 * `models.json` 的结构由 llm-manager 定义：
 *
 * ```json
 * { "version": 1, "models": [ { id, name, alias, file, mmproj, ctxK, port, ... } ] }
 * ```
 *
 * 本模块对字段缺失、类型错误、文件损坏一律容错：丢弃单条坏记录而不是
 * 让整次同步失败 —— 一个模型写坏了不该让其它模型也用不了。
 *
 * @module dsh-llamacpp-connect/config-store
 */

/** 解析后的单个模型条目（只保留接入所需字段） */
export interface ManagerModel {
  id: string
  name: string
  alias: string
  port: number
  ctxK: number
  /** 视觉投影文件名；非多模态模型为 undefined */
  mmproj?: string
  vision: boolean
}

export interface ParseResult {
  models: ManagerModel[]
  /** 被跳过的条目及原因，供界面提示 */
  skipped: Array<{ index: number; reason: string }>
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
}

function asPort(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined
}

/**
 * 解析 models.json 的原始文本。
 *
 * @param raw 文件内容
 * @returns 解析结果；JSON 本身损坏时返回空列表并给出原因
 */
export function parseModels(raw: string): ParseResult {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    return { models: [], skipped: [{ index: -1, reason: `JSON 解析失败: ${(e as Error).message}` }] }
  }

  const list = (doc as { models?: unknown })?.models
  if (!Array.isArray(list)) {
    return { models: [], skipped: [{ index: -1, reason: 'models 字段不是数组' }] }
  }

  const models: ManagerModel[] = []
  const skipped: ParseResult['skipped'] = []
  const seenPorts = new Set<number>()

  list.forEach((item, index) => {
    if (typeof item !== 'object' || item === null) {
      skipped.push({ index, reason: '不是对象' })
      return
    }
    const m = item as Record<string, unknown>

    const id = asString(m.id)
    if (!id) {
      skipped.push({ index, reason: '缺少 id' })
      return
    }

    const port = asPort(m.port)
    if (port === undefined) {
      skipped.push({ index, reason: `端口无效: ${String(m.port)}` })
      return
    }
    // 端口重复会导致两个 provider 指向同一实例，属配置错误
    if (seenPorts.has(port)) {
      skipped.push({ index, reason: `端口 ${port} 与前面的模型重复` })
      return
    }
    seenPorts.add(port)

    const name = asString(m.name) ?? id
    // 别名是 OpenAI API 里的 model 字段；缺失时退回 id
    const alias = asString(m.alias) ?? id
    const mmproj = asString(m.mmproj)
    const ctxKRaw = Number(m.ctxK)
    const ctxK = Number.isFinite(ctxKRaw) && ctxKRaw > 0 ? Math.round(ctxKRaw) : 32

    models.push({
      id,
      name,
      alias,
      port,
      ctxK,
      mmproj: mmproj ?? undefined,
      // 管理器里 vision 是显式开关，同时有 mmproj 才算真能看图
      vision: m.vision === true && Boolean(mmproj),
    })
  })

  return { models, skipped }
}

/** provider id：模型 id 前加统一前缀，避免与其它插件的 provider 撞名 */
export function providerIdFor(modelId: string): string {
  const safe = modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `llamacpp-${safe || 'model'}`
}

/** 上游 baseUrl：每个模型独占端口 */
export function baseUrlFor(model: ManagerModel): string {
  return `http://127.0.0.1:${model.port}/v1`
}
