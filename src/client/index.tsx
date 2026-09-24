/**
 * client 半：把一张卡片注册进 DSH 主设置面板（设置 → 左侧导航项）。
 *
 * 挂载点照官方 `settings.section` slot（`@deepseek-ai/dsh-client-ui-settings-general`
 * 声明，kind: 'list'）—— 注册项提供 `name` + `id` + `order` + `label`，注册即可见。
 * 官方示例（`@deepseek-ai/dsh-cordis-client-runner` 的 slots 契约）：
 *
 *   return {
 *     inject: ['slots'],
 *     apply(ctx) {
 *       ctx.slots.inject('settings.section', () => ctx.slots.register(
 *         { name: 'settings.section', id: 'my-entry', order: 100, label: 'My entry' },
 *         () => React.createElement('div', null, 'hello'),
 *       ))
 *     },
 *   }
 *
 * 组件用 `react.createElement` 渲染、`react.useState` 等 hook 管理状态，
 * 与官方 client 包的产物形态一致（裸 `let react = require("react")`）。
 *
 * host 与 client 之间的数据通道是同源 HTTP —— 宿主用 `ctx.webServer.register()`
 * 注册两个路由，这里直接 fetch，不往 ctx 挂自定义属性。
 *
 * @module dsh-llamacpp-connect/client
 */

/**
 * react 由构建 banner 以裸 `require("react")` 注入为模块内变量（见 tsdown.config.ts），
 * 这里只做类型声明、不写 import —— 这是官方 client 包的产物形态，
 * 避免 rolldown 对 external 的 `__toESM` 包装把 `react.useState` 弄成 null。
 *
 * 不声明/不 require `react/jsx-runtime`：本组件只用 `react.createElement`。
 * 客户端模块系统里一次 require 未命中会让**整个 factory** 物化失败，
 * 用不到的依赖不引入。
 */
declare const react: typeof import('react')

/** 纯类型导入：只用于标注组件返回类型，不产生运行时代码 */
import type { ReactElement } from 'react'

/** 与宿主约定的路径，需与 index.ts 的 STATUS_PATH / SYNC_PATH 保持一致 */
export const STATUS_PATH = '/plugins/dsh-llamacpp-connect/status'
export const SYNC_PATH = '/plugins/dsh-llamacpp-connect/sync'

/** 卡片在设置面板里的 id（settings.section 是 list slot，需要 id） */
export const SECTION_ID = 'llamacpp-connect'

/** 依赖的客户端服务：面板注册靠 slots */
export const inject = ['slots']

/** 插件名：client 半的 name 与 host 半一致，供 loader 识别 */
export const name = 'dsh-llamacpp-connect'

export interface ModelRow {
  id: string
  name: string
  alias: string
  port: number
  ctxK: number
  vision: boolean
  running: boolean
}

export interface StatusPayload {
  ok: boolean
  installed: boolean
  managerDir?: string
  controlApi: boolean
  models: ModelRow[]
  skipped: Array<{ index: number; reason: string }>
  lastSyncAt?: number
  lastError?: string
}

/** 卡片文案：模块内自足，不依赖宿主 locale 注入 */
const zh = {
  cardTitle: 'llama.cpp Connect',
  cardDesc: '把本地 llama.cpp 管理器里的模型接入 DeepSeek Harness',
  connected: '已连接管理器',
  canAutoStart: '可自动启动',
  syncOnly: '仅同步（无控制接口）',
  syncBtn: '同步模型',
  syncing: '同步中…',
  retry: '重试',
  recheck: '重新检测',
  loading: '读取中…',
  notInstalled: '未检测到 llama.cpp 管理器。请先安装并运行它，然后在其中配置模型。',
  running: '运行中',
  notRunning: '未运行',
  vision: '视觉',
  syncDone: '同步完成，共 {count} 个模型',
  syncFailed: '同步失败：{reason}',
  syncError: '同步异常：{reason}',
  readError: '无法读取状态：{reason}',
  unknownReason: '未知原因',
  skipped: '已跳过 {count} 条异常配置：',
} as const

type CopyKey = keyof typeof zh

/** 翻译函数（模块内自足） */
function t(key: CopyKey, params?: Record<string, unknown>): string {
  const template: string = zh[key] ?? String(key)
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''))
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 } as const,
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as const,
  badge: (on: boolean) =>
    ({
      fontSize: 11,
      padding: '2px 7px',
      borderRadius: 5,
      background: on ? 'rgba(26,143,90,.14)' : 'rgba(154,154,160,.16)',
      color: on ? '#1a8f5a' : '#9a9aa0',
    }) as const,
  btn: {
    fontSize: 12,
    padding: '5px 12px',
    borderRadius: 7,
    border: '1px solid rgba(0,0,0,.16)',
    background: 'transparent',
    cursor: 'pointer',
  } as const,
  card: {
    border: '1px solid rgba(0,0,0,.09)',
    borderRadius: 9,
    padding: '9px 11px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  } as const,
  mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11 } as const,
  hint: { fontSize: 11, color: '#9a9aa0', lineHeight: 1.7 } as const,
}

/**
 * 卡片组件：显示管理器连接状态、模型列表，并提供「同步模型」按钮。
 *
 * 照官方写法：用 `react.createElement` 渲染、`react.useState` 等 hook 管理状态。
 * 数据走同源 HTTP fetch（STATUS_PATH / SYNC_PATH）。
 */
export function ConfigPage(): ReactElement {
  const [state, setState] = react.useState<StatusPayload | null>(null)
  const [busy, setBusy] = react.useState(false)
  const [message, setMessage] = react.useState('')

  const refresh = react.useCallback(async () => {
    try {
      const res = await fetch(STATUS_PATH)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setState((await res.json()) as StatusPayload)
      setMessage('')
    } catch (e) {
      setMessage(t('readError', { reason: (e as Error).message }))
    }
  }, [])

  react.useEffect(() => {
    void refresh()
  }, [refresh])

  const onSync = react.useCallback(async () => {
    setBusy(true)
    setMessage('')
    try {
      const res = await fetch(SYNC_PATH, { method: 'POST' })
      const body = (await res.json()) as {
        ok?: boolean
        count?: number
        error?: string
        state?: StatusPayload
      }
      if (body.state) setState(body.state)
      setMessage(
        body.ok
          ? t('syncDone', { count: body.count ?? 0 })
          : t('syncFailed', { reason: body.error ?? t('unknownReason') }),
      )
    } catch (e) {
      setMessage(t('syncError', { reason: (e as Error).message }))
    } finally {
      setBusy(false)
    }
  }, [])

  if (message && !state) {
    return react.createElement(
      'div',
      { style: styles.wrap },
      react.createElement('div', { style: { ...styles.hint, color: '#d13b3b' } }, message),
      react.createElement(
        'div',
        { style: styles.row },
        react.createElement('button', { style: styles.btn, onClick: refresh }, t('retry')),
      ),
    )
  }

  if (!state) return react.createElement('div', { style: styles.hint }, t('loading'))

  if (!state.installed) {
    return react.createElement(
      'div',
      { style: styles.wrap },
      react.createElement('div', { style: styles.hint }, t('notInstalled')),
      react.createElement(
        'div',
        { style: styles.row },
        react.createElement(
          'button',
          { style: styles.btn, onClick: onSync, disabled: busy },
          busy ? t('syncing') : t('recheck'),
        ),
      ),
      message && react.createElement('div', { style: styles.hint }, message),
      state.lastError &&
        react.createElement('div', { style: { ...styles.hint, color: '#b8791a' } }, state.lastError),
    )
  }

  return react.createElement(
    'div',
    { style: styles.wrap },

    react.createElement(
      'div',
      { style: styles.row },
      react.createElement('span', { style: styles.badge(true) }, t('connected')),
      react.createElement(
        'span',
        { style: styles.badge(state.controlApi) },
        state.controlApi ? t('canAutoStart') : t('syncOnly'),
      ),
      react.createElement(
        'button',
        { style: { ...styles.btn, marginLeft: 'auto' }, onClick: onSync, disabled: busy },
        busy ? t('syncing') : t('syncBtn'),
      ),
    ),

    state.managerDir &&
      react.createElement('div', { style: { ...styles.hint, ...styles.mono } }, state.managerDir),

    react.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
      ...state.models.map((m) =>
        react.createElement(
          'div',
          { key: m.id, style: styles.card },
          react.createElement(
            'div',
            { style: styles.row },
            react.createElement('span', { style: { fontWeight: 550 } }, m.name),
            m.vision && react.createElement('span', { style: styles.badge(true) }, t('vision')),
            react.createElement(
              'span',
              { style: { ...styles.badge(m.running), marginLeft: 'auto' } },
              m.running ? t('running') : t('notRunning'),
            ),
          ),
          react.createElement(
            'div',
            { style: { ...styles.hint, ...styles.mono } },
            `${m.alias} · 端口 ${m.port} · 上下文 ${m.ctxK}K`,
          ),
        ),
      ),
    ),

    state.skipped.length > 0 &&
      react.createElement(
        'div',
        { style: { ...styles.hint, color: '#b8791a' } },
        t('skipped', { count: state.skipped.length }) +
          state.skipped.map((s) => `#${s.index} ${s.reason}`).join('；'),
      ),

    message && react.createElement('div', { style: styles.hint }, message),
    state.lastError &&
      react.createElement('div', { style: { ...styles.hint, color: '#d13b3b' } }, state.lastError),
  )
}

/**
 * 客户端入口：照官方模式把卡片注册进主设置面板。
 *
 * 整个函数体外包 try/catch：DSH 的 slot API 仍在演进，一旦签名变化，
 * 这里退化成 console.error 而不是把异常抛进 DSH 加载器、触发红色
 * 「插件加载失败」横幅。host 侧的 provider 注册不受影响。
 */
export function apply(ctx: {
  slots: {
    inject: (name: string, cb: () => unknown) => unknown
    register: (options: Record<string, unknown>, component: unknown) => () => void
  }
}): void {
  try {
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: SECTION_ID,
          order: 100,
          label: () => t('cardTitle'),
        },
        ConfigPage,
      ),
    )
  } catch (error) {
    console.error(
      '[dsh-llamacpp-connect] client card failed to load (host provider unaffected):',
      error,
    )
  }
}

/**
 * 注意：**绝不能** `export default ConfigPage`。
 *
 * cordis-plugin-loader 的 `unwrapExports()` 会做
 *   exports = exports.default ?? exports
 * 一旦存在 default 导出，宿主就会把「组件函数」当成「插件本体」，
 * 客户端 runner 随即按函数式插件处理并调用 `ConfigPage(ctx)` ——
 * 组件在 **React 渲染上下文之外** 执行，首个 `react.useState()` 抛
 * `Cannot read properties of null (reading 'useState')`，
 * 表现为红色的「插件加载失败」横幅。
 *
 * 官方 client 包（settings-general / settings-models 等）的产物都只导出
 * apply / inject / name，没有 default 导出。
 * 回归测试已锁定这一点（tests/plugin-contract.spec.ts）。
 */
