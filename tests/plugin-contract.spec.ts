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

  it('通过 register 注册 HTTP 路由（经幂等包装）', () => {
    // 现在统一走 registerOnce，内部才调 server.register
    expect(codeOnly).toMatch(/server\.register\(route\)|\.register\(\{/)
    expect(codeOnly).toMatch(/registerOnce/)
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
 * `apply(ctx)`，由它注册 slot。只导出裸组件时宿主无事可做 ——
 * 面板永远不出现，而 host 侧 provider 注册照常工作，
 * 于是表现为「模型能用但设置里找不到面板」。
 *
 * 挂载点用 `settings.section`（主设置面板的 list slot），而不是
 * `settings.plugin.item`：后者是 keyed slot，且「插件配置」页会把它与
 * 宿主服务的设置命名空间**取交集**后才派发，任一侧缺失就永远空白。
 * `settings.section` 注册即可见，是更稳妥的挂载点。
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

  it('注册到主设置面板 settings.section', () => {
    expect(codeOnly).toMatch(/settings\.section/)
    expect(codeOnly).toMatch(/\.register\s*\(/)
  })

  it('list slot 必须提供 id 与 label', () => {
    // settings.section 声明为 kind: 'list'；
    // 缺 id 时 UI-slots 会抛 'list slot ... requires options.id'
    expect(codeOnly).toMatch(/\bid\s*:/)
    expect(codeOnly).toMatch(/\blabel\s*:/)
  })

  it('不再注册到 keyed 的 settings.plugin.item（避免命名空间交集过滤）', () => {
    expect(codeOnly).not.toMatch(/settings\.plugin\.item/)
  })

  it('不注入 locale、不使用 inject face（防 ctx.t 崩溃）', () => {
    // 整个客户端入口不得出现 locale 服务或 inject face：
    // 宿主的 slot 渲染可能把 ctx 当 props 传下来，组件读 props.t 会打到
    // ctx.t，抛 `cannot get property "t" without inject`，插件加载失败。
    expect(codeOnly).not.toMatch(/ctx\.locale/)
    expect(codeOnly).not.toMatch(/\binject\s*:\s*\(\)\s*=>/)
    expect(codeOnly).not.toMatch(/locale\s*:/)
  })

  it('卡片组件不接受任何 props', () => {
    expect(codeOnly).toMatch(/export function ConfigPage\(\)/)
  })

  it('apply 与 slot 注册同处一个模块', () => {
    const applyIdx = codeOnly.search(/export function apply\s*\(/)
    const regIdx = codeOnly.search(/settings\.section/)
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

  it('声明了 settings.section 的 slot 提供方', () => {
    // settings.section 由 dsh-client-ui-settings-general 声明；
    // 它同时声明 settings.section 与 settings.general.item 两个 list slot。
    expect(pkg.dsh?.client?.inject ?? []).toContain(
      '@deepseek-ai/dsh-client-ui-settings-general',
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

/**
 * 防回归：路由注册必须幂等，能扛过 Cordis 的 HMR `Fiber._reload()`。
 *
 * 真实故障（线上稳定复现，每次重启都出现）：
 *
 *   webserver: duplicate exact route "/plugins/dsh-llamacpp-connect/status"
 *       at callback (lib/index.js:614) -> Proxy.inject -> apply (612)
 *   cannot create effect on inactive context
 *       at apply (lib/index.js:645) -> Fiber.effect
 *
 * 触发链（取自线上完整调用栈）：
 *   Fiber._reload (cordis:1355)        ← HMR config reload
 *     -> Fiber._execute (1136)
 *       -> apply 被**再次执行**（同一个 fiber）
 *         -> ctx.inject 回调重跑 -> 重复注册 -> 抛错
 *         -> 外层 ctx 已失效 -> ctx.effect -> INACTIVE_EFFECT
 *
 * 关键结论（实测五种写法得出）：
 *   「把 register 的 disposer 登记好」**解决不了**这个问题 ——
 *   `_reload` 重跑 `apply` 时上一轮的清理尚未完成，路由仍在宿主的
 *   全局路由表里。唯一可靠的做法是**注册前先探测，已存在则跳过**。
 */
describe('路由注册幂等（扛 HMR reload）', () => {
  /** 最小 WebServer 桩：与 dsh-host-webserver 的 register 语义一致 */
  function makeWebServer() {
    const exact = new Map<string, unknown>()
    return {
      exact,
      register(route: { kind: string; path: string }) {
        if (exact.has(route.path)) {
          throw new Error(
            `webserver: duplicate ${route.kind} route "${route.path}"`,
          )
        }
        exact.set(route.path, route)
        return () => exact.delete(route.path)
      },
    }
  }

  it('宿主 WebServer 对重复路由确实会抛错（前提验证）', () => {
    const ws = makeWebServer()
    ws.register({ kind: 'exact', path: '/x' })
    expect(() => ws.register({ kind: 'exact', path: '/x' })).toThrow(
      /duplicate exact route/,
    )
  })

  it('源码使用幂等守卫，而不是仅依赖 disposer', async () => {
    const src = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

    // 必须有「已注册则跳过」的判断（registeredRoutes.has / exact.has 之类）
    expect(codeOnly).toMatch(/registeredRoutes\.has\(|exact\.has\(/)
  })

  it('HMR _reload 后不抛 duplicate route', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const root = new Context()
    const ws = makeWebServer()
    root.provide('webServer', ws)
    // 插件的顶层 inject 是 ['llm']，缺它 fiber 不会激活到 apply
    root.provide('llm', { registerAdapter: () => () => {} })

    // 用真实的插件 apply（从源码构建产物加载）
    const mod = (await import(
      'file://' + join(process.cwd(), 'lib', 'index.js').replace(/\\/g, '/')
    )) as {
      name: string
      inject: string[]
      Config: unknown
      apply: (ctx: unknown, config: unknown) => () => void
    }

    const plugin = {
      name: mod.name,
      inject: mod.inject,
      Config: mod.Config,
      apply: mod.apply,
    }

    const fiber = await root.plugin(plugin, {
      managerDir: join(process.cwd(), '__nonexistent__'),
      autoStart: false,
    })
    const afterFirst = ws.exact.size
    expect(afterFirst, '首次 apply 应注册 2 条路由').toBe(2)

    // 复现线上路径：HMR 触发 _reload，重新执行 apply
    const errors: string[] = []
    const ctxLogger = (
      fiber as unknown as { ctx: { logger: { error: (e: unknown) => void } } }
    ).ctx
    const origError = ctxLogger.logger.error
    ctxLogger.logger.error = (e: unknown) => {
      errors.push(String((e as Error)?.message ?? e))
    }

    await (fiber as unknown as { _reload: () => Promise<void> })._reload()

    ctxLogger.logger.error = origError

    expect(
      errors.filter((e) => e.includes('duplicate exact route')),
      `_reload 后出现重复路由: ${errors.join(' | ')}`,
    ).toHaveLength(0)
    expect(
      errors.filter((e) => e.includes('inactive context')),
      `_reload 后出现 INACTIVE_EFFECT: ${errors.join(' | ')}`,
    ).toHaveLength(0)
    expect(ws.exact.size, '_reload 后路由数应仍为 2').toBe(2)
  })
})

/**
 * 防回归：client 产物必须是 DSH 客户端模块格式，不能是原生 ESM。
 *
 * 真实故障：client 半用 `format: 'esm'` 产出顶层 `import React ...`，
 * 被 concat 进非 module 的 combo script 后浏览器抛
 * "Cannot use import statement outside a module"，并连带把同批其它插件的
 * client bundle 一起炸掉（导致整个 web profile 进入 safe mode）。
 *
 * 正确产物形状（与官方 client 包 lib/client.js 一致，如
 * @deepseek-ai/dsh-client-ui-settings-general）：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 * 执行时只登记 factory，工厂体经注入的 require 解析 react 等外部依赖，
 * 返回 { apply, inject }。
 */
describe('client 产物格式（DSH 客户端模块）', () => {
  const clientPath = join(process.cwd(), 'lib', 'client', 'index.js')

  it('产物存在且以 __ModuleLoader__.load 包裹', () => {
    let raw: string
    try {
      raw = readFileSync(clientPath, 'utf8')
    } catch {
      throw new Error(`client 产物未构建：${clientPath} 不存在，请先 pnpm run build`)
    }
    expect(raw).toContain('window.__ModuleLoader__.load({')
    expect(raw).toMatch(/factory:\s*\(require\)\s*=>/)
  })

  it('产物不含顶层 ESM import（这是浏览器崩溃的根因）', () => {
    const raw = readFileSync(clientPath, 'utf8')
    const lines = raw.split('\n')
    const topLevelImports = lines.filter((l) => /^import\s/.test(l.trim()))
    expect(
      topLevelImports,
      `发现顶层 import（必须经 require 注入）: ${topLevelImports.join(' | ')}`,
    ).toHaveLength(0)
  })

  it('产物在 factory 体内声明 module/exports 并返回', () => {
    const raw = readFileSync(clientPath, 'utf8')
    expect(raw).toContain('var module = { exports: {} }')
    expect(raw).toContain('return module.exports')
  })

  it('react 以裸 require 注入，不经过 __toESM 包装（防 useState 变 null）', () => {
    // 真实故障：rolldown 对 external 的 CJS 默认导入生成
    //   let react = require("react"); react = __toESM(react, 1)
    // __toESM 拿不到具名导出时退回 {}，react.useState 变 undefined，
    // 渲染期抛 `Cannot read properties of null (reading 'useState')`。
    // 对齐官方 client 包：react 由 banner 裸 require 注入，无包装。
    const raw = readFileSync(clientPath, 'utf8')
    expect(raw).toMatch(/const react = require\("react"\)/)
    expect(raw).toMatch(/const react_jsx_runtime = require\("react\/jsx-runtime"\)/)
    // 绝不能出现把 react 二次包装成 ESM namespace 的 __toESM 调用
    expect(raw).not.toMatch(/__toESM\(\s*react\b/)
    expect(raw).not.toMatch(/react = __toESM/)
  })
})
