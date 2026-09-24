import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 运行状态驱动的模型集合。
 *
 * 需求：模型选择列表**只包含当前正在运行的模型**；拿不到运行状态时**一个也不列**。
 *
 * 这些用例把**真实的构建产物**装进**真实 Cordis 宿主**，再配一个假的管理器
 * HTTP 服务，因此覆盖的是「宿主按它的方式加载插件时会发生什么」，
 * 而不是「函数在被单独调用时对不对」。
 */

const LIB = join(process.cwd(), 'lib', 'index.js')
const PLUGIN_URL = 'file://' + LIB.replace(/\\/g, '/')

const STATUS_PATH = '/plugins/dsh-llamacpp-connect/status'
const SYNC_PATH = '/plugins/dsh-llamacpp-connect/sync'

type FixtureModel = {
  id: string
  name: string
  alias: string
  port: number
  ctxK: number
  vision: boolean
  mmproj?: string
}

/**
 * 两个模型，端口**每次测试现取一个保证空闲的端口**。
 *
 * 这点很重要：模型端口就是 provider 的上游地址。取空闲端口才能保证
 * 「上游必定连不上」，从而让 stream 类断言确定性成立
 * （写死 8080 时，机器上恰好有服务在听就会让测试悄悄变成另一种结果）。
 */
let MODELS: FixtureModel[] = []

/** 拿一个当前空闲的端口 */
async function freePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()))
  const port = (srv.address() as AddressInfo).port
  await new Promise<void>((resolve) => srv.close(() => resolve()))
  return port
}

beforeEach(async () => {
  MODELS = [
    {
      id: 'balanced',
      name: 'Qwen 35B',
      alias: 'Qwen-35B',
      port: await freePort(),
      ctxK: 32,
      vision: false,
    },
    {
      id: 'vl',
      name: 'Qwen VL',
      alias: 'Qwen-VL',
      port: await freePort(),
      ctxK: 64,
      mmproj: 'mm.gguf',
      vision: true,
    },
  ]
})

type Manager = {
  port: number
  setRunning: (ids: string[]) => void
  close: () => Promise<void>
}

/** 假管理器：`GET /status` 按当前 running 集合回答（其余端点 404） */
async function startManager(runningIds: string[]): Promise<Manager> {
  let running = runningIds
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/status')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          models: MODELS.map((m) => ({
            id: m.id,
            name: m.name,
            alias: m.alias,
            port: m.port,
            running: running.includes(m.id),
          })),
        }),
      )
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    setRunning: (ids) => {
      running = ids
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/** 一个可被 locateManager 认出的管理器数据目录 */
async function writeManagerDir(apiPort: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llamacpp-run-'))
  await writeFile(join(dir, 'models.json'), JSON.stringify({ version: 1, models: MODELS }), 'utf8')
  await writeFile(join(dir, 'api-port.txt'), String(apiPort), 'utf8')
  await writeFile(join(dir, 'api-token.txt'), 'test-token', 'utf8')
  return dir
}

/**
 * 宿主 WebServer 的最小替身：记录注册的路由，便于直接调用处理器。
 *
 * **必须提供 `exact`**：插件优先用宿主路由表判断「这条路由是否已注册」，
 * 只有拿不到 `exact` 时才回退到模块级集合（而模块实例在测试间是共享的）。
 * 真实宿主的 webServer 就带 `exact`（见 logs 里的 `duplicate exact route`），
 * 所以替身也照此建模，否则会得到一个真实环境不会出现的假失败。
 */
function makeWebServer() {
  const routes = new Map<
    string,
    { handler: (req: { method?: string }, res: unknown) => unknown }
  >()
  return {
    routes,
    exact: {
      has: (path: string) => routes.has(path),
    },
    register(route: {
      path: string
      handler: (req: { method?: string }, res: unknown) => unknown
    }) {
      if (routes.has(route.path)) {
        throw new Error(`webserver: duplicate exact route "${route.path}"`)
      }
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

type RouteReply = Record<string, unknown>

function makeRes() {
  const out = { code: 0, body: '' }
  return {
    out,
    res: {
      writeHead: (code: number) => {
        out.code = code
      },
      end: (body?: string) => {
        out.body = body ?? ''
      },
    },
  }
}

/** 等待条件成立（插件启动时的同步是 fire-and-forget） */
async function waitFor(cond: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`等待超时：${label}`)
}

type Harness = {
  /** 每次 registerAdapter 的 provider id */
  registered: string[]
  /** 捕获到的适配器（与 registered 一一对应），用于直接驱动 stream 路径 */
  adapters: Array<{ listModels: (p: string) => Promise<Array<{ id: string }>>; stream: (o: unknown) => AsyncGenerator<unknown> }>
  status: () => Promise<RouteReply>
  /** 状态路由的 HTTP 状态码（卸载后应为 503） */
  statusCode: () => Promise<number>
  sync: () => Promise<RouteReply>
  dispose: () => Promise<void>
}

async function boot(managerDir: string): Promise<Harness> {
  const { Context } = await import('@deepseek-ai/cordis')
  const root = new Context()
  const ws = makeWebServer()
  const registered: string[] = []
  const adapters: Harness['adapters'] = []

  root.provide('webServer', ws)
  root.provide('llm', {
    registerAdapter: (ids: string[], adapter: Harness['adapters'][number]) => {
      registered.push(ids[0]!)
      adapters.push(adapter)
      return () => {}
    },
  })

  const mod = (await import(PLUGIN_URL)) as {
    name: string
    inject: string[]
    Config: unknown
    apply: (ctx: unknown, config: unknown) => () => void
  }

  const fiber = (await root.plugin(
    { name: mod.name, inject: mod.inject, Config: mod.Config, apply: mod.apply },
    { managerDir },
  )) as { dispose?: () => unknown }

  const callRouteRaw = async (
    path: string,
    method: string,
  ): Promise<{ code: number; body: RouteReply }> => {
    const route = ws.routes.get(path)
    if (!route) throw new Error(`路由未注册：${path}`)
    const { res, out } = makeRes()
    await route.handler({ method }, res)
    return { code: out.code, body: JSON.parse(out.body) as RouteReply }
  }

  return {
    registered,
    adapters,
    status: async () => (await callRouteRaw(STATUS_PATH, 'GET')).body,
    statusCode: async () => (await callRouteRaw(STATUS_PATH, 'GET')).code,
    sync: async () => (await callRouteRaw(SYNC_PATH, 'POST')).body,
    dispose: async () => {
      await fiber.dispose?.()
    },
  }
}

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

describe('模型集合由「正在运行」决定', () => {
  it('只注册运行中的模型；卡片与选择列表一致', async () => {
    if (!existsSync(LIB)) throw new Error(`缺少构建产物 ${LIB}，请先 pnpm run build`)

    const manager = await startManager(['balanced'])
    cleanup.push(() => manager.close())
    const dir = await writeManagerDir(manager.port)
    cleanup.push(() => rm(dir, { recursive: true, force: true }))

    const h = await boot(dir)
    await waitFor(() => h.registered.length > 0, '注册运行中的模型')

    // 只有 balanced 在运行 → 只注册它
    expect(h.registered).toEqual(['llamacpp-balanced'])

    const st = await h.status()
    expect(st.runningCount).toBe(1)
    expect(st.totalCount).toBe(2)
    const rows = st.models as Array<{ id: string; running: boolean }>
    expect(rows.map((r) => r.id)).toEqual(['balanced'])
    expect(rows.every((r) => r.running)).toBe(true)
  })

  it('运行集合变化后，同步会跟着增删', async () => {
    const manager = await startManager(['balanced'])
    cleanup.push(() => manager.close())
    const dir = await writeManagerDir(manager.port)
    cleanup.push(() => rm(dir, { recursive: true, force: true }))

    const h = await boot(dir)
    await waitFor(() => h.registered.length === 1, '首次同步')
    expect(h.registered).toEqual(['llamacpp-balanced'])

    // 管理器里又启动了一个模型 → 重新注册为「两个」
    manager.setRunning(['balanced', 'vl'])
    const up = await h.sync()
    expect(up.count).toBe(2)
    expect(h.registered.slice(1), '增删应为「仅注册运行中的」').toEqual([
      'llamacpp-balanced',
      'llamacpp-vl',
    ])

    let st = await h.status()
    expect(st.runningCount).toBe(2)
    expect((st.models as Array<{ id: string }>).map((r) => r.id)).toEqual(['balanced', 'vl'])

    // 又停掉一个 → 只剩 vl
    manager.setRunning(['vl'])
    const down = await h.sync()
    expect(down.count).toBe(1)
    expect(h.registered.slice(3)).toEqual(['llamacpp-vl'])

    st = await h.status()
    expect(st.runningCount).toBe(1)
    expect((st.models as Array<{ id: string }>).map((r) => r.id)).toEqual(['vl'])
  })

  it('运行集合未变时跳过重注册（不打断进行中的请求）', async () => {
    const manager = await startManager(['balanced'])
    cleanup.push(() => manager.close())
    const dir = await writeManagerDir(manager.port)
    cleanup.push(() => rm(dir, { recursive: true, force: true }))

    const h = await boot(dir)
    await waitFor(() => h.registered.length === 1, '首次同步')

    // 连点两次「立即刷新」，运行集合没有变化
    await h.sync()
    await h.sync()

    expect(h.registered, '集合未变时不应再次 registerAdapter').toEqual(['llamacpp-balanced'])
  })

  it('拿不到运行状态时一个模型也不列', async () => {
    const manager = await startManager(['balanced'])
    const dir = await writeManagerDir(manager.port)
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    // 关掉管理器 = 控制接口不可达（端口/令牌文件仍在，所以 available 为 true）
    await manager.close()

    const h = await boot(dir)
    // 给它足够时间跑完一次同步
    await new Promise((r) => setTimeout(r, 600))

    expect(h.registered, '无法判定运行状态时不应注册任何模型').toEqual([])

    const st = await h.status()
    expect(st.models).toEqual([])
    expect(st.runningCount).toBe(0)
    expect(String(st.lastError ?? '')).toMatch(/运行状态|控制接口/)
  })

  it('卸载插件时 disposer 被调用（否则轮询与注册都会泄漏）', async () => {
    // 真实故障：`export function apply(...)` 有 prototype，被 cordis 的
    // isConstructor() 判定为类式插件，于是用 `new apply(ctx, config)` 调用，
    // **返回值不再被收集为 disposer**。副作用照常发生，所以功能看起来正常，
    // 但插件卸载时永远不做清理。
    // 这里用「卸载后路由必须降级为 503」来证明 disposer 真的执行了。
    const manager = await startManager(['balanced'])
    cleanup.push(() => manager.close())
    const dir = await writeManagerDir(manager.port)
    cleanup.push(() => rm(dir, { recursive: true, force: true }))

    const h = await boot(dir)
    await waitFor(() => h.registered.length === 1, '首次同步')
    expect(await h.statusCode(), '卸载前应正常服务').toBe(200)

    await h.dispose()

    // cordis 的 fiber 清理是异步链（_unload 的 inertia），轮询等待收敛
    let code = await h.statusCode()
    for (let i = 0; i < 40 && code !== 503; i++) {
      await new Promise((r) => setTimeout(r, 25))
      code = await h.statusCode()
    }
    expect(code, '卸载后 disposer 必须执行并把路由降级为 503').toBe(503)
  })

  it('注册的适配器 profile 自带 streamIdleTimeoutMs（stream 不抛 idleWatchdog）', async () => {
    // 真实故障：手搓 profile 绕过了 dsh-llm-pi-ai 的 resolveProfiles() 归一化，
    // 缺 streamIdleTimeoutMs → stream 一开就抛
    //   idleWatchdog timeoutMs must be a positive finite number no greater than 2147483647
    // 这里真的去驱动 stream（该字段在 streamWithSnapshot 的第 6 步被读取），
    // 断言错误里**不再**出现 idleWatchdog —— 上游连不上是另一回事，不算这次的问题。
    const manager = await startManager(['balanced'])
    cleanup.push(() => manager.close())
    const dir = await writeManagerDir(manager.port)
    cleanup.push(() => rm(dir, { recursive: true, force: true }))

    const h = await boot(dir)
    await waitFor(() => h.registered.length === 1, '首次同步')

    const provider = 'llamacpp-balanced'
    const adapter = h.adapters[0]!
    const models = await adapter.listModels(provider)
    expect(models.length, '适配器应能列出模型').toBeGreaterThan(0)

    // 把流**抽干**：只调一次 next() 只会拿到起始事件，走不到网络层，
    // 那样断言就是空转。上游端口是刚取的空闲端口，必定连不上，
    // 所以这里必然会以一个错误结束 —— 而那个错误绝不能是 idleWatchdog。
    let caught: unknown
    try {
      for await (const _chunk of adapter.stream({
        provider,
        model: models[0]!.id,
        messages: [],
      })) {
        // 不关心内容，只关心它是否能越过 idleWatchdog 走到上游
      }
    } catch (e) {
      caught = e
    }

    expect(
      String((caught as Error | undefined)?.message ?? ''),
      'stream 不得因 profile.streamIdleTimeoutMs 无效而抛 idleWatchdog',
    ).not.toMatch(/idleWatchdog/)
  })
})
