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
    expect(codeOnly).toMatch(/\/plugins\/dsh-local-llm-connect\/status/)
    expect(codeOnly).toMatch(/\/plugins\/dsh-local-llm-connect\/sync/)
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

  it('导出 apply，且必须是箭头函数（不可构造）', () => {
    // cordis 用 isConstructor() 判断插件形态：普通函数有 prototype，会被当成
    // 类式插件用 `new callback(ctx, config)` 调用，返回值不再被收集为 disposer。
    // 因此 apply 必须是箭头函数。
    expect(codeOnly).toMatch(/export const apply\s*=\s*\(/)
    expect(codeOnly).not.toMatch(/export function apply\s*\(/)
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
    const applyIdx = codeOnly.search(/export const apply\s*=\s*\(/)
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
    '/plugins/dsh-local-llm-connect/status',
    '/plugins/dsh-local-llm-connect/sync',
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
 *   webserver: duplicate exact route "/plugins/dsh-local-llm-connect/status"
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
    // 绝不能出现把 react 二次包装成 ESM namespace 的 __toESM 调用
    expect(raw).not.toMatch(/__toESM\(\s*react\b/)
    expect(raw).not.toMatch(/react = __toESM/)
  })

  it('不 require 用不到的 react/jsx-runtime（一次未命中会炸掉整个 factory）', () => {
    // 本组件只用 react.createElement。客户端模块系统里 require 未命中会抛错并
    // 让整个 factory 物化失败（dsh-client-modules/lib/client.js:300-309），
    // 因此不引入用不到的依赖。
    const raw = readFileSync(clientPath, 'utf8')
    expect(raw).not.toMatch(/require\("react\/jsx-runtime"\)/)
    expect(raw).not.toMatch(/react_jsx_runtime/)
  })

  it('产物不得带 default 导出（否则组件会被当成插件本体直接调用）', () => {
    // 真实故障（这个坑耗了最久）：
    // cordis-plugin-loader 的 unwrapExports() 会执行
    //   exports = exports.default ?? exports
    // 一旦 client 产物里有 `exports.default = ConfigPage`，宿主解析出的
    // 「插件」就是那个组件函数；客户端 runner 见插件是函数便按函数式插件处理，
    // 直接调用 `ConfigPage(ctx)` —— 组件在 React 渲染上下文之外执行，
    // 首个 react.useState() 抛
    //   Cannot read properties of null (reading 'useState')
    // 表现为启动后的红色「插件加载失败」横幅（且插件被 safe-mode 禁用）。
    //
    // 官方 client 包与 dsh-workbuddy-connect 的产物都只导出 apply/inject/name。
    const raw = readFileSync(clientPath, 'utf8')
    expect(raw).not.toMatch(/exports\.default\s*=/)
    // 源码层面同样禁止
    const clientSource = readFileSync(
      join(process.cwd(), 'src', 'client', 'index.tsx'),
      'utf8',
    )
    const sourceCodeOnly = clientSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(sourceCodeOnly).not.toMatch(/export\s+default\s/)
  })

  it('client 的 .d.ts 不得被 banner/footer 污染（必须是合法 TypeScript）', () => {
    // 真实缺陷：banner/footer 早先用统一字符串形式，于是 .d.ts 也被裹上
    // `window.__ModuleLoader__.load({...` 并以 `return module.exports; } });` 结尾，
    // 而 package.json 的 exports["./client"].types 正指向该文件。
    // 修法是 tsdown 的 ChunkAddonObject（{ js }）只作用于 JS chunk。
    const dtsPath = join(process.cwd(), 'lib', 'client', 'index.d.ts')
    let dts: string
    try {
      dts = readFileSync(dtsPath, 'utf8')
    } catch {
      throw new Error(`client 声明文件未生成：${dtsPath} 不存在，请先 pnpm run build`)
    }
    expect(dts).not.toContain('__ModuleLoader__')
    expect(dts).not.toContain('module.exports')
    // 必须仍是可用的声明文件
    expect(dts).toMatch(/export /)
  })
})

/**
 * 防回归：host 半在 HMR / patch 热重载下的健壮性。
 *
 * 真实故障（日志堆栈）：
 *   cannot get required service "llm" in inactive context
 *     at sync (.../dsh-local-llm-connect/lib/index.js)
 *     at async Object.handler (.../lib/index.js)   ← /sync 路由处理器
 *
 * 成因：路由只在进程内注册一次，但处理器闭包捕获了某一次 apply 的 ctx；
 * 热重载后该 ctx 失效，点「同步模型」就会去读死 ctx。
 * 修法：处理器统一从模块级 `live` 取当前代实现；卸载时清空 → 明确返回 503。
 */
describe('host 半的热重载健壮性契约', () => {
  const host = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')
  const codeOnly = host
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('路由处理器通过模块级 live 取当前代，而不是直接闭包捕获 ctx', () => {
    expect(codeOnly).toMatch(/let live: LiveGeneration \| undefined/)
    expect(codeOnly).toMatch(/live = \{ sync, status: buildStatusPayload \}/)
    // 两个处理器都必须经 live 取当前代
    const handlerUses = codeOnly.match(/const current = live/g) ?? []
    expect(handlerUses.length, '两个路由处理器都应经 live 取当前代').toBe(2)
    expect(codeOnly).toMatch(/await current\.sync\(\)/)
    expect(codeOnly).toMatch(/await current\.status\(\)/)
    // 不得再直接调用本次 apply 的 sync / buildStatusPayload
    expect(codeOnly).not.toMatch(/await sync\(\)/)
    expect(codeOnly).not.toMatch(/await buildStatusPayload\(\)/)
  })

  it('卸载时清空 live，且只在仍是当前代时清', () => {
    expect(codeOnly).toMatch(/if \(live\?\.sync === sync\) live = undefined/)
  })

  it('同步串行化，避免并发触发 DUPLICATE_ADAPTER', () => {
    expect(codeOnly).toMatch(/let syncTail: Promise<unknown> = Promise\.resolve\(\)/)
    expect(codeOnly).toMatch(/syncTail\.then\(\(\) => runSync\(\)\)/)
  })

  it('路由存在性以宿主路由表为准，模块级集合只作兜底', () => {
    // 顺序不能反：模块级集合跨 HMR 代际残留，短路在前会导致路由被静默漏注册
    const fnBody = codeOnly.slice(codeOnly.indexOf('const alreadyRegistered'))
    const probeAt = fnBody.indexOf('server.exact')
    const setAt = fnBody.indexOf('registeredRoutes.has')
    expect(probeAt, '应优先探测宿主路由表').toBeGreaterThan(-1)
    expect(setAt, '应有本地集合兜底').toBeGreaterThan(-1)
    expect(probeAt, '宿主探测必须排在本地集合之前').toBeLessThan(setAt)
  })

  it('同步失败日志带 message，不能只甩 error 对象（会被格式化成 {}）', () => {
    expect(codeOnly).toMatch(/const detail = err\?\.message \?\? String\(e\)/)
    expect(codeOnly).toMatch(/首次同步失败: \$\{detail\}/)
  })

  it('解析适配器失败时不破坏已有 provider（import 在 unregisterAll 之前）', () => {
    const body = codeOnly.slice(codeOnly.indexOf('const runSync'))
    const importAt = body.indexOf("await import('@deepseek-ai/dsh-llm-pi-ai')")
    const unregisterAt = body.indexOf('unregisterAll()', importAt)
    expect(importAt, 'runSync 里应有动态 import').toBeGreaterThan(-1)
    expect(unregisterAt, 'import 之后才撤销旧注册').toBeGreaterThan(importAt)
  })
})

/**
 * 防回归：插件入口必须「不可构造」。
 *
 * cordis 这样区分插件形态（cordis/lib/index.js:1065-1071）：
 *
 *   function isConstructor(func) {
 *     if (!func.prototype) return false   // 箭头函数
 *     return true                          // 普通函数（含 function 声明）
 *   }
 *   if (isConstructor(callback)) {
 *     const instance = new callback(ctx, config)   // ← 用 new 调用
 *     return instance?.[symbols.init]?.()          // ← 返回值被丢弃
 *   }
 *   return callback(ctx, config)                   // ← 返回值才被 collect 成 disposer
 *
 * 所以 `export function apply(...)` 会让 disposer 永远不被收集：插件卸载时
 * 轮询定时器泄漏、适配器不被撤销。副作用照常发生，功能看起来正常 ——
 * 这正是它藏得深的原因。这两条直接检查**构建产物**里的 apply。
 */
describe('插件入口不可构造（disposer 才会被收集）', () => {
  it('host 产物的 apply 没有 prototype', async () => {
    const mod = (await import(
      'file://' + join(process.cwd(), 'lib', 'index.js').replace(/\\/g, '/')
    )) as { apply?: { prototype?: unknown } }
    expect(typeof mod.apply, 'host 必须导出 apply').toBe('function')
    expect(mod.apply?.prototype, 'host apply 必须是箭头函数').toBeUndefined()
  })

  it('client 产物的 apply 没有 prototype', async () => {
    const { readFileSync } = await import('node:fs')
    const vm = await import('node:vm')
    const raw = readFileSync(join(process.cwd(), 'lib', 'client', 'index.js'), 'utf8')

    const factories = new Map<string, (req: (s: string) => unknown) => Record<string, unknown>>()
    const sandbox = {
      window: {
        __ModuleLoader__: {
          load: (r: { id: string; factory: (req: (s: string) => unknown) => Record<string, unknown> }) =>
            factories.set(r.id, r.factory),
        },
      },
      console,
      Symbol,
      Object,
      Reflect,
      JSON,
      Map,
      Set,
      Promise,
      Error,
    }
    ;(sandbox as Record<string, unknown>).globalThis = sandbox
    vm.createContext(sandbox)
    vm.runInContext(raw, sandbox, { filename: 'client.js' })

    const factory = factories.get('dsh-local-llm-connect')
    expect(factory, 'client 产物应登记 factory').toBeDefined()

    const reactStub = {
      useState: (init: unknown) => [init, () => {}],
      useCallback: (fn: unknown) => fn,
      useEffect: () => {},
      createElement: () => ({}),
    }
    const exported = factory!((spec: string) =>
      spec === 'react' ? reactStub : { jsx: () => ({}), jsxs: () => ({}) },
    )

    expect(typeof exported.apply, 'client 必须导出 apply').toBe('function')
    expect((exported.apply as { prototype?: unknown }).prototype, 'client apply 必须是箭头函数').toBeUndefined()
  })
})
