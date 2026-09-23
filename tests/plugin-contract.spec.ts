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
