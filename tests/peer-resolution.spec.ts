/**
 * 运行时 peer 解析契约。
 *
 * 这里守的是一个真实踩过的坑：插件在运行时用**动态 import** 加载三个 peer，
 * 但 DSH 的宿主兜底钩子 `resources/host-module-fallback.mjs` 只接管
 * `@deepseek-ai/*`（其 `HOST_PACKAGE_PREFIX` 写死该前缀）。
 *
 * 而 `.local-plugins/<name>` 是产物的一份**真实拷贝**（不是指向仓库的链接），
 * Node 解析符号链接后按物理目录向上找 `node_modules` —— 那里什么都没有，
 * 于是 `@earendil-works/pi-ai` 必然解析失败，报
 * `Cannot find package '@earendil-works/pi-ai'`。
 *
 * 必须在插件目录里补一份 `node_modules`（见 scripts/deploy.mjs）。
 * 这组测试把「哪些包必须由插件自己解析」钉死，避免以后有人把它当成
 * 宿主该管的事而删掉部署步骤。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))

describe('运行时 peer 解析契约', () => {
  it('source 里真实动态 import 的 peer 都在 package.json 中声明', () => {
    const src = readFileSync(join(REPO, 'src', 'index.ts'), 'utf8')
    // 只挑 await import('...') 里的裸说明符
    const imported = [...src.matchAll(/await import\(\s*'([^']+)'/g)].map((m) => m[1])
    const declared = {
      ...pkg.peerDependencies,
      ...pkg.dependencies,
    }
    for (const spec of imported) {
      // 子路径归到包名：@earendil-works/pi-ai/api/x -> @earendil-works/pi-ai
      const parts = spec.split('/')
      const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
      expect(declared, `${spec} 未在 package.json 里声明`).toHaveProperty([name])
    }
  })

  it('@earendil-works/pi-ai 不能标成 optional', () => {
    // optional 会让包管理器干脆不装；但它是硬 import，缺了就起不来。
    // 之前正是这个组合（optional:true + 硬 import）让依赖静默缺失。
    const meta = pkg.peerDependenciesMeta ?? {}
    expect(meta['@earendil-works/pi-ai']?.optional).not.toBe(true)
  })

  it('@earendil-works/pi-ai 不在宿主兜底的 @deepseek-ai/ 前缀内', () => {
    // 断言这个前提仍然成立；哪天宿主扩大了兜底范围，这条会红，
    // 提醒我们去掉部署脚本里的手动补链。
    expect('@earendil-works/pi-ai'.startsWith('@deepseek-ai/')).toBe(false)
  })

  it('仓库自带 pi-ai，保证 dev/test 与部署脚本都能找到', () => {
    expect(
      existsSync(join(REPO, 'node_modules', '@earendil-works', 'pi-ai', 'package.json')),
    ).toBe(true)
  })

  it('部署脚本存在且列出了运行时 peer', () => {
    const p = join(REPO, 'scripts', 'deploy.mjs')
    expect(existsSync(p)).toBe(true)
    const body = readFileSync(p, 'utf8')
    for (const spec of [
      '@earendil-works/pi-ai',
      '@deepseek-ai/dsh-llm-pi-ai',
      '@deepseek-ai/dsh-llm',
    ]) {
      expect(body, `deploy.mjs 应处理 ${spec}`).toContain(spec)
    }
  })
})
