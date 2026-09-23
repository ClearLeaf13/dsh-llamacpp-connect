/**
 * 配置页：显示管理器连接状态、模型列表，并提供「同步」按钮。
 *
 * host 与 client 之间的数据通道是同源 HTTP —— 宿主用
 * `ctx.webServer.register()` 注册两个路由，这里直接 fetch。
 * 不走 ctx 上的自定义属性：Cordis 的上下文是服务容器，未 provide 的
 * key 不允许赋值。
 *
 * 入口形态：DSH 的 client 模块系统要求导出 `apply(ctx)` + `inject`，
 * 由 apply 把卡片注册进「设置 → 插件」。只导出裸 React 组件是不够的——
 * 宿主拿到组件的 `default` 无事可做，面板不会出现，而 host 侧 provider
 * 注册照常工作，于是表现为「模型能用但设置里找不到面板」。
 *
 * @module dsh-llamacpp-connect/client
 */

import React, { useCallback, useEffect, useState } from 'react'

/** 与宿主约定的路径，需与 index.ts 的 STATUS_PATH / SYNC_PATH 保持一致 */
export const STATUS_PATH = '/plugins/dsh-llamacpp-connect/status'
export const SYNC_PATH = '/plugins/dsh-llamacpp-connect/sync'

/**
 * 卡片在设置页里的 key。
 *
 * 关键：`settings.plugin.item` 是 **keyed** slot，而 DSH 0.1.5 的
 * 「设置 → 插件 → 插件配置」面板按「宿主服务的设置命名空间」派发卡片 ——
 * 每个卡片的 `key` 必须等于 host 半经 `ctx.settings.installSection()`
 * 注册的命名空间（这里与 src/index.ts 的 SETTINGS_NS 一致，均为 'llamacpp'）。
 * 两者不一致时面板永远不显示（取交集）。
 */
export const CARD_KEY = 'llamacpp'

/** 文案命名空间 */
const NS = 'settings.llamacpp'

/**
 * 依赖的客户端服务。
 *
 * `slots` 由 `@deepseek-ai/dsh-client-ui-renderer` 提供，是注册面板的前提；
 * `locale` 由 `@deepseek-ai/dsh-client-locale` 提供，用于文案。
 * 这两个包必须同时出现在 package.json 的 `dsh.client.inject` 里，
 * Cordis 才会在本插件的 fiber 启动前把服务准备好。
 */
export const inject = ['slots', 'locale']

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

/**
 * 文案字典。
 *
 * `register(ns, { zh, en })` 要求 locale id 是 BCP 47 风格标签，
 * 且同一 namespace 下不能重复注册同一语言。
 */
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
}

const en: typeof zh = {
  cardTitle: 'llama.cpp Connect',
  cardDesc: 'Bring local llama.cpp manager models into DeepSeek Harness',
  connected: 'Manager connected',
  canAutoStart: 'Auto-start available',
  syncOnly: 'Sync only (no control API)',
  syncBtn: 'Sync models',
  syncing: 'Syncing…',
  retry: 'Retry',
  recheck: 'Re-check',
  loading: 'Loading…',
  notInstalled:
    'No llama.cpp manager detected. Install and run it, then configure models there.',
  running: 'Running',
  notRunning: 'Stopped',
  vision: 'Vision',
  syncDone: 'Synced {count} model(s)',
  syncFailed: 'Sync failed: {reason}',
  syncError: 'Sync error: {reason}',
  readError: 'Cannot read status: {reason}',
  unknownReason: 'unknown error',
  skipped: 'Skipped {count} invalid entr(ies):',
}

/** 翻译函数签名；由 apply 从 locale 服务注入 */
export type Translate = (key: keyof typeof zh, params?: Record<string, unknown>) => string

/** 兜底翻译：locale 不可用时直接返回中文，保证卡片仍可读 */
function fallbackT(key: keyof typeof zh, params?: Record<string, unknown>): string {
  const template = zh[key] ?? key
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

export function ConfigPage({ t = fallbackT }: { t?: Translate } = {}): React.ReactElement {
  const [state, setState] = useState<StatusPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(STATUS_PATH)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setState((await res.json()) as StatusPayload)
      setMessage('')
    } catch (e) {
      // 宿主路由没注册时也会走到这里（例如 webServer 服务不可用）
      setMessage(t('readError', { reason: (e as Error).message }))
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onSync = useCallback(async () => {
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
  }, [t])

  if (message && !state) {
    return React.createElement('div', { style: styles.wrap },
      React.createElement('div', { style: { ...styles.hint, color: '#d13b3b' } }, message),
      React.createElement('div', { style: styles.row },
        React.createElement('button', { style: styles.btn, onClick: refresh }, t('retry'))))
  }

  if (!state) return React.createElement('div', { style: styles.hint }, t('loading'))

  if (!state.installed) {
    return React.createElement('div', { style: styles.wrap },
      React.createElement('div', { style: styles.hint }, t('notInstalled')),
      React.createElement('div', { style: styles.row },
        React.createElement('button', { style: styles.btn, onClick: onSync, disabled: busy },
          busy ? t('syncing') : t('recheck'))),
      message && React.createElement('div', { style: styles.hint }, message),
      state.lastError &&
        React.createElement('div', { style: { ...styles.hint, color: '#b8791a' } }, state.lastError))
  }

  return React.createElement(
    'div',
    { style: styles.wrap },

    React.createElement('div', { style: styles.row },
      React.createElement('span', { style: styles.badge(true) }, t('connected')),
      React.createElement('span', { style: styles.badge(state.controlApi) },
        state.controlApi ? t('canAutoStart') : t('syncOnly')),
      React.createElement('button', {
        style: { ...styles.btn, marginLeft: 'auto' },
        onClick: onSync,
        disabled: busy,
      }, busy ? t('syncing') : t('syncBtn'))),

    state.managerDir &&
      React.createElement('div', { style: { ...styles.hint, ...styles.mono } }, state.managerDir),

    React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
      ...state.models.map((m) =>
        React.createElement('div', { key: m.id, style: styles.card },
          React.createElement('div', { style: styles.row },
            React.createElement('span', { style: { fontWeight: 550 } }, m.name),
            m.vision && React.createElement('span', { style: styles.badge(true) }, t('vision')),
            React.createElement('span', {
              style: { ...styles.badge(m.running), marginLeft: 'auto' },
            }, m.running ? t('running') : t('notRunning'))),
          React.createElement('div', { style: { ...styles.hint, ...styles.mono } },
            `${m.alias} · 端口 ${m.port} · 上下文 ${m.ctxK}K`)))),

    state.skipped.length > 0 &&
      React.createElement('div', { style: { ...styles.hint, color: '#b8791a' } },
        t('skipped', { count: state.skipped.length }) +
        state.skipped.map((s) => `#${s.index} ${s.reason}`).join('；')),

    message && React.createElement('div', { style: styles.hint }, message),
    state.lastError &&
      React.createElement('div', { style: { ...styles.hint, color: '#d13b3b' } }, state.lastError),
  )
}

/**
 * 客户端入口。
 *
 * 把卡片注册进「设置 → 插件」。`settings.plugin.item` 是 **keyed** slot
 * （由 `@deepseek-ai/dsh-client-ui-settings-plugins` 声明为
 * `{ kind: 'keyed', scope: 'root' }`），因此注册时必须提供 `key`。
 *
 * `slots.inject(名字, 回调)` 是「声明感知」注册：只有当某个父级条目确实
 * 声明了该 slot 时回调才执行。设置页尚未挂载时不会抛错，挂载后会自动执行——
 * 这正好也提供了缺 slot 时的优雅降级。
 *
 * 整个函数体外包 try/catch：DSH 的 slot API 仍在演进（例如 rc 阶段发生过
 * `id→key` / `order→priority` 重命名），一旦签名变化，这里应退化成
 * console.error 而不是把异常抛进 DSH 加载器、触发红色「插件加载失败」横幅。
 * host 侧的 provider 注册不受影响。
 */
export function apply(ctx: {
  effect: (cb: () => unknown, label?: string) => unknown
  locale: {
    register: (ns: string, dicts: Record<string, unknown>) => () => void
    bind: (ns: string) => Translate
  }
  slots: {
    inject: (name: string, cb: () => unknown) => unknown
    register: (options: Record<string, unknown>, component: unknown) => () => void
  }
}): void {
  try {
    ctx.effect(
      () => ctx.locale.register(NS, { zh, en }),
      'dsh-llamacpp-connect: settings copy',
    )

    const t = ctx.locale.bind(NS)

    ctx.slots.inject('settings.plugin.item', () =>
      ctx.slots.register(
        {
          name: 'settings.plugin.item',
          key: CARD_KEY,
          priority: 30,
          inject: () => ({ t }),
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

export default ConfigPage
