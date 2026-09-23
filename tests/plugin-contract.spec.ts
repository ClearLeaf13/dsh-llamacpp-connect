import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 防回归：插件不得往 Cordis 上下文上挂自定义属性。
 *
 * Cordis 的 ctx 是服务容器，只有经 `ctx.provide()` 声明的 key 才允许
 * 赋值。写成 `ctx.someName = value` 或 `ctx.set('someName', value)` 会让
 * **整个插件加载失败**，错误形如：
 *
 *   cannot set property "someName" without provide
 *
 * 这个坑真实发生过：v0.1.0 里写了 `ctx.set('llamacppConnect', ...)`，
 * 导致 DSH 启动时插件树加载失败、DSH 无法启动。
 *
 * 数据通道应改用 `ctx.webServer.register()` 注册 HTTP 路由。
 */
describe('插件入口不得非法写入 ctx', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')

  it('不出现 ctx.xxx = value 形式的赋值', () => {
    // 匹配 ctx.foo = 但不匹配 ctx.foo === / ctx.foo == （比较运算）
    const assign = /ctx\.[A-Za-z_$][\w$]*\s*=(?!=)/g
    const hits = source.match(assign) ?? []
    expect(hits, `发现非法赋值: ${hits.join(', ')}`).toHaveLength(0)
  })

  it('不调用 ctx.set()', () => {
    expect(source).not.toMatch(/ctx\.set\s*\(/)
  })

  it('注册 HTTP 路由应走 webServer.register', () => {
    expect(source).toMatch(/webServer\.register/)
  })

  it('路由注册包在 ctx.effect 里，便于卸载时回收', () => {
    // ctx.effect 调用次数应至少覆盖状态与同步两个路由
    const effects = source.match(/ctx\.effect\?\.\(/g) ?? []
    expect(effects.length).toBeGreaterThanOrEqual(2)
  })
})
