import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 防回归：插件的 ctx 使用必须符合 Cordis 的服务容器规则。
 *
 * 这里记录了两个**真实踩过**的坑，每一个都会让整个插件加载失败、
 * 进而导致 DSH 无法启动（DSH 会把插件自动移除并进入安全模式）：
 *
 * 1. `ctx.someName = value` / `ctx.set('someName', ...)`
 *      → cannot set property "someName" without provide
 *    只有经 ctx.provide() 声明的 key 才允许赋值。
 *
 * 2. 直接读 `ctx.webServer`
 *      → cannot get property "webServer" without inject
 *    服务必须先经 ctx.inject([...]) 注入才能访问。
 *
 * 数据通道的正确做法：用 `ctx.inject(['webServer'], webCtx => ...)`
 * 拿到子上下文后 register HTTP 路由，客户端同源 fetch。
 */
describe('插件入口的 ctx 用法契约', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')

  /** 去掉注释后再做静态检查，避免注释里提到的反例被误判 */
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/^\s*\/\/.*$/gm, '')        // 行注释

  it('不出现 ctx.xxx = value 形式的赋值', () => {
    // 匹配 ctx.foo = 但不匹配 ctx.foo === / ==（比较运算）
    const hits = codeOnly.match(/ctx\.[A-Za-z_$][\w$]*\s*=(?!=)/g) ?? []
    expect(hits, `发现非法赋值: ${hits.join(', ')}`).toHaveLength(0)
  })

  it('不调用 ctx.set()', () => {
    expect(codeOnly).not.toMatch(/ctx\.set\s*\(/)
  })

  it('不直接读 ctx.webServer，必须经 ctx.inject', () => {
    expect(codeOnly).not.toMatch(/ctx\.webServer/)
    expect(codeOnly).toMatch(/ctx\.inject\(\s*\['webServer'\]/)
  })

  it('通过 register 注册 HTTP 路由', () => {
    expect(codeOnly).toMatch(/\.register\(\{/)
  })

  it('两个路由路径都在源码里声明', () => {
    expect(codeOnly).toMatch(/\/plugins\/dsh-llamacpp-connect\/status/)
    expect(codeOnly).toMatch(/\/plugins\/dsh-llamacpp-connect\/sync/)
  })

  it('顶层 inject 只声明 llm，webServer 走可选注入', () => {
    // webServer 是可选依赖：宿主没有它时插件仍应正常加载并注册 provider，
    // 因此不能放进顶层 inject 数组（放进去会导致缺服务时整行挂不上）
    const m = codeOnly.match(/export const inject\s*=\s*\[([^\]]*)\]/)
    expect(m).not.toBeNull()
    expect(m![1]).toContain('llm')
    expect(m![1]).not.toContain('webServer')
  })
})

describe('客户端与宿主的路由路径一致', () => {
  const host = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')
  const client = readFileSync(join(process.cwd(), 'src', 'client', 'index.tsx'), 'utf8')

  const paths = [
    '/plugins/dsh-llamacpp-connect/status',
    '/plugins/dsh-llamacpp-connect/sync',
  ]

  for (const p of paths) {
    it(`两端都声明了 ${p}`, () => {
      expect(host).toContain(p)
      expect(client).toContain(p)
    })
  }
})
