import { describe, it, expect } from 'vitest'

import { buildAdapterProfile } from '../src/index.js'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

/**
 * 防回归：手搓的 pi-ai profile 必须自带官方归一化会补上的字段。
 *
 * 我们是**手搓 profile** 直接交给 `PiAiAdapter({ profiles })`，绕过了
 * `dsh-llm-pi-ai` 的 `resolveProfiles()`（它没有导出）。而 stream 路径直接读这些
 * 字段、没有兜底，于是真实故障是：
 *
 *   idleWatchdog timeoutMs must be a positive finite number no greater than 2147483647
 *
 * —— `profile.streamIdleTimeoutMs` 是 undefined，`idleWatchdog()`
 * （dsh-timeout/lib/index.js:85-86）一校验就抛。
 *
 * 下面这段 `assertTimerDelay` 是逐字复刻 dsh-timeout 的实现（它同样没导出），
 * 用它来断言我们的 profile 能过官方校验。
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

function assertTimerDelay(timeoutMs: unknown, name: string): void {
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(`${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/** 与生产同样的构造方式 */
function makeProfile() {
  return buildAdapterProfile({
    provider: 'llamacpp-balanced',
    displayName: 'Qwen 35B',
    piProvider: {},
    resolveRetryPolicy,
  })
}

describe('pi-ai profile 必须自带官方归一化的字段', () => {
  it('streamIdleTimeoutMs 能通过 idleWatchdog 的校验', () => {
    const p = makeProfile()
    expect(() => assertTimerDelay(p.streamIdleTimeoutMs, 'idleWatchdog timeoutMs')).not.toThrow()
    expect(p.streamIdleTimeoutMs).toBe(300_000)
  })

  it('负对照：缺字段的旧 profile 会被官方校验拒绝（这就是发布出去的 bug）', () => {
    // 修复前 sync() 里手写的 profile：没有 streamIdleTimeoutMs
    const buggy = {
      provider: 'llamacpp-balanced',
      displayName: 'Qwen 35B',
      piProvider: {},
      configuredMaxTokens: new Map(),
      modelErrors: new Map(),
    } as unknown as Record<string, unknown>

    expect(() => assertTimerDelay(buggy.streamIdleTimeoutMs, 'idleWatchdog timeoutMs')).toThrow(
      /idleWatchdog timeoutMs must be a positive finite number/,
    )
  })

  it('图片预算三项都是正整数（视觉模型会用到）', () => {
    const p = makeProfile()
    for (const key of [
      'maxRequestImageBytes',
      'requestImagePixelBudget',
      'requestImageMaxBytes',
    ] as const) {
      const value = p[key]
      expect(Number.isInteger(value), `${key} 必须是整数（实际 ${String(value)}）`).toBe(true)
      expect(value as number).toBeGreaterThan(0)
      // 且不得超出 timer 上限（官方对这几个字段也用同一上限校验）
      expect(value as number).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS)
    }
  })

  it('retryPolicy 已被归一化（不能是 undefined）', () => {
    // dsh-llm-pi-ai:2567 的 registrationFacts() 直接读 profile.retryPolicy
    const p = makeProfile()
    expect(p.retryPolicy).toBeDefined()
    expect(typeof p.retryPolicy).toBe('object')
  })

  it('保留 adapter 需要的其余字段', () => {
    const p = makeProfile()
    expect(p.provider).toBe('llamacpp-balanced')
    expect(p.displayName).toBe('Qwen 35B')
    expect(p.piProvider).toBeDefined()
    expect(p.configuredMaxTokens).toBeInstanceOf(Map)
    expect(p.modelErrors).toBeInstanceOf(Map)
  })
})
