/**
 * 配置页：显示管理器连接状态、模型列表，并提供「同步」按钮。
 *
 * host 与 client 之间的数据通道是同源 HTTP —— 宿主用
 * `ctx.webServer.register()` 注册两个路由，这里直接 fetch。
 * 不走 ctx 上的自定义属性：Cordis 的上下文是服务容器，未 provide 的
 * key 不允许赋值。
 *
 * @module dsh-llamacpp-connect/client
 */

import React, { useCallback, useEffect, useState } from 'react'

/** 与宿主约定的路径，需与 index.ts 的 STATUS_PATH / SYNC_PATH 保持一致 */
export const STATUS_PATH = '/plugins/dsh-llamacpp-connect/status'
export const SYNC_PATH = '/plugins/dsh-llamacpp-connect/sync'

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

export function ConfigPage(): React.ReactElement {
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
      setMessage(`无法读取状态：${(e as Error).message}`)
    }
  }, [])

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
        body.ok ? `同步完成，共 ${body.count ?? 0} 个模型` : `同步失败：${body.error ?? '未知原因'}`,
      )
    } catch (e) {
      setMessage(`同步异常：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [])

  if (message && !state) {
    return React.createElement('div', { style: styles.wrap },
      React.createElement('div', { style: { ...styles.hint, color: '#d13b3b' } }, message),
      React.createElement('div', { style: styles.row },
        React.createElement('button', { style: styles.btn, onClick: refresh }, '重试')))
  }

  if (!state) return React.createElement('div', { style: styles.hint }, '读取中…')

  if (!state.installed) {
    return React.createElement('div', { style: styles.wrap },
      React.createElement('div', { style: styles.hint },
        '未检测到 llama.cpp 管理器。请先安装并运行它，然后在其中配置模型。'),
      React.createElement('div', { style: styles.row },
        React.createElement('button', { style: styles.btn, onClick: onSync, disabled: busy },
          busy ? '同步中…' : '重新检测')),
      message && React.createElement('div', { style: styles.hint }, message),
      state.lastError &&
        React.createElement('div', { style: { ...styles.hint, color: '#b8791a' } }, state.lastError))
  }

  return React.createElement(
    'div',
    { style: styles.wrap },

    React.createElement('div', { style: styles.row },
      React.createElement('span', { style: styles.badge(true) }, '已连接管理器'),
      React.createElement('span', { style: styles.badge(state.controlApi) },
        state.controlApi ? '可自动启动' : '仅同步（无控制接口）'),
      React.createElement('button', {
        style: { ...styles.btn, marginLeft: 'auto' },
        onClick: onSync,
        disabled: busy,
      }, busy ? '同步中…' : '同步模型')),

    state.managerDir &&
      React.createElement('div', { style: { ...styles.hint, ...styles.mono } }, state.managerDir),

    React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
      ...state.models.map((m) =>
        React.createElement('div', { key: m.id, style: styles.card },
          React.createElement('div', { style: styles.row },
            React.createElement('span', { style: { fontWeight: 550 } }, m.name),
            m.vision && React.createElement('span', { style: styles.badge(true) }, '视觉'),
            React.createElement('span', {
              style: { ...styles.badge(m.running), marginLeft: 'auto' },
            }, m.running ? '运行中' : '未运行')),
          React.createElement('div', { style: { ...styles.hint, ...styles.mono } },
            `${m.alias} · 端口 ${m.port} · 上下文 ${m.ctxK}K`)))),

    state.skipped.length > 0 &&
      React.createElement('div', { style: { ...styles.hint, color: '#b8791a' } },
        `已跳过 ${state.skipped.length} 条异常配置：` +
        state.skipped.map((s) => `#${s.index} ${s.reason}`).join('；')),

    message && React.createElement('div', { style: styles.hint }, message),
    state.lastError &&
      React.createElement('div', { style: { ...styles.hint, color: '#d13b3b' } }, state.lastError),
  )
}

export default ConfigPage
