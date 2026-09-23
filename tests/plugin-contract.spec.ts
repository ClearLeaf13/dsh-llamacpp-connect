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

/**
 * 防回归：client 入口必须把自己**注册进设置页**。
 *
 * 真实踩过的坑：`src/client/index.tsx` 起初只 `export function ConfigPage`，
 * 没有 `apply` / `inject`。DSH 的 client 模块系统要求 client 入口导出
 * `apply(ctx)`，由它调 `ctx.slots.register({ name: 'settings.plugin.item' }, C)`
 * 把卡片挂进「设置 → 插件」。只导出裸组件时宿主无事可做 ——
 * 面板永远不出现，而 host 侧 provider 注册照常工作，
 * 于是表现为「模型能用但设置里找不到面板」。
 */
describe('client 入口的设置页注册契约', () => {
  const client = readFileSync(join(process.cwd(), 'src', 'client', 'index.tsx'), 'utf8')
  const codeOnly = client
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('导出 apply', () => {
    expect(codeOnly).toMatch(/export function apply\s*\(/)
  })

  it('导出 inject 并声明 slots 服务', () => {
    expect(codeOnly).toMatch(/export const inject\s*=/)
    expect(codeOnly).toMatch(/['"]slots['"]/)
  })

  it('注册到 settings.plugin.item', () => {
    expect(codeOnly).toMatch(/settings\.plugin\.item/)
    expect(codeOnly).toMatch(/\.register\s*\(/)
  })

  it('keyed slot 必须提供 key', () => {
    // settings.plugin.item 声明为 kind: 'keyed'；
    // 缺 key 时 UI-slots 会抛 'keyed slot ... requires options.key'
    expect(codeOnly).toMatch(/\bkey\s*:/)
  })

  it('导出的 apply 不早于 slot 注册所需的一切（apply 在文件内定义）', () => {
    // apply 必须与 ConfigPage 同处一个模块，且被导出（上面的用例已断言）
    const applyIdx = codeOnly.search(/export function apply\s*\(/)
    const regIdx = codeOnly.search(/settings\.plugin\.item/)
    expect(applyIdx).toBeGreaterThan(-1)
    expect(regIdx).toBeGreaterThan(-1)
  })
})

describe('package.json 的 client 依赖声明', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    dsh?: { client?: { inject?: string[] } }
  }

  it('声明了 slots 服务所在包', () => {
    // slots 服务由 dsh-client-ui-renderer 提供；inject 不到就注册不了 slot。
    // 声明 dsh-client-locale 只解决文案，不解决面板缺失。
    expect(pkg.dsh?.client?.inject ?? []).toContain('@deepseek-ai/dsh-client-ui-renderer')
  })

  it('声明了 settings.plugin.item 的 slot 提供方', () => {
    expect(pkg.dsh?.client?.inject ?? []).toContain(
      '@deepseek-ai/dsh-client-ui-settings-plugins',
    )
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
