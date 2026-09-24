#!/usr/bin/env node
/**
 * 把构建产物同步到 DSH 的本地插件目录，并补齐 peer 依赖闭包。
 *
 * 为什么需要这个脚本
 * ------------------
 * DSH 以符号链接（Windows 下是 junction）加载 `.local-plugins/<name>`。Node 会把
 * 符号链接解析到**物理目录**，所以插件里的 `import '@earendil-works/pi-ai'` 是从
 * 物理目录向上找 `node_modules` 的。
 *
 * 宿主提供的兜底钩子 `resources/host-module-fallback.mjs` 只接管
 * `@deepseek-ai/*`（其常量 HOST_PACKAGE_PREFIX 写死了这个前缀），
 * `@earendil-works/pi-ai` 不在其中。而 `.local-plugins/<name>` 是仓库产物的一份
 * **真实拷贝**、不是指向仓库的链接，因此它既没有自己的 `node_modules`，
 * 也没有任何上层目录能兜住 `@earendil-works/*`。
 *
 * 结果就是运行时抛 `Cannot find package '@earendil-works/pi-ai'`。
 * 解决办法：在本插件目录下建一份 `node_modules`，把运行时真正需要的 peer
 * 用 junction 指过去。指向哪一份？优先 DSH 自带的那份（版本由宿主保证一致），
 * 找不到再退回仓库自己的 `node_modules`。
 *
 * 用法：
 *   node scripts/deploy.mjs [--plugin-dir <path>] [--dry-run]
 */

import { existsSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

/**
 * 手写递归复制。
 *
 * 不用 `fs.cpSync`：在 Windows + 本机的 Node 24 上，对含子目录的树调用它会
 * 直接以 `0xC0000409`（STATUS_STACK_BUFFER_OVERRUN）原生崩溃，进程无输出退出，
 * 排查成本很高。逐层 readdir + copyFile 稳定。
 */
const copyTree = (from, to) => {
  const st = statSync(from)
  if (st.isDirectory()) {
    rmSync(to, { recursive: true, force: true })
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from)) copyTree(join(from, entry), join(to, entry))
  } else {
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
  }
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 运行时动态 import 的包：(名字, 从仓库解析时的入口) —— 必须与 src/index.ts 一致 */
const RUNTIME_PEERS = [
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-llm',
  '@earendil-works/pi-ai',
  // pi-ai 的子路径入口，同样需要可解析
  '@earendil-works/pi-telemetry',
]

/** 除运行时 peer 外，还需要从本目录解析到的包（peer 的传递依赖由宿主目录自带） */
const SCOPE_DIRS = ['@deepseek-ai', '@earendil-works']

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const pluginDirArg = args.indexOf('--plugin-dir')
const pluginDir =
  pluginDirArg >= 0
    ? resolve(args[pluginDirArg + 1])
    : resolve(
        process.env.DSH_HOME ??
          join(process.env.APPDATA ?? '', 'dsh-desktop', 'harness'),
        '.local-plugins',
        'dsh-local-llm-connect',
      )

const log = (msg) => console.log(`[deploy] ${msg}`)
const warn = (msg) => console.warn(`[deploy] ! ${msg}`)

if (!existsSync(pluginDir)) {
  console.error(`[deploy] 目标插件目录不存在：${pluginDir}`)
  process.exit(1)
}

// ── 1. 同步构建产物 ────────────────────────────────────────────────
const ARTIFACTS = ['lib', 'cordis.patch.yml', 'package.json', 'README.md', 'LICENSE']
for (const name of ARTIFACTS) {
  const from = join(REPO, name)
  if (!existsSync(from)) {
    warn(`仓库缺少 ${name}，跳过`)
    continue
  }
  const to = join(pluginDir, name)
  if (dryRun) {
    log(`would sync ${name}`)
    continue
  }
  rmSync(to, { recursive: true, force: true })
  copyTree(from, to)
  log(`synced ${name}`)
}

// ── 2. 定位每个 peer 的可用来源 ────────────────────────────────────
/** 候选根：DSH 安装目录优先（版本与宿主一致），其次共享 profiles 兜底，最后仓库 */
const CANDIDATE_ROOTS = [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'DSH Desktop', 'resources', 'app', 'node_modules'),
  join(pluginDir, '..', '..', 'profiles', 'node_modules'),
  join(REPO, 'node_modules'),
].filter((p) => existsSync(p))

log(`候选依赖来源：\n${CANDIDATE_ROOTS.map((p) => `    ${p}`).join('\n')}`)

/** 返回第一个真实包含该包（有 package.json）的候选目录 */
const locate = (spec) => {
  for (const root of CANDIDATE_ROOTS) {
    const dir = join(root, spec)
    if (existsSync(join(dir, 'package.json'))) return dir
  }
  return undefined
}

// ── 3. 重建 node_modules 里的 junction ─────────────────────────────
const nmDir = join(pluginDir, 'node_modules')
if (!dryRun) mkdirSync(nmDir, { recursive: true })

let missing = 0
for (const scope of SCOPE_DIRS) {
  if (!dryRun) mkdirSync(join(nmDir, scope), { recursive: true })
}

for (const spec of RUNTIME_PEERS) {
  const target = locate(spec)
  if (target === undefined) {
    warn(`解析不到 ${spec}（候选源里都没有），插件运行时仍会报错`)
    missing += 1
    continue
  }
  const link = join(nmDir, spec)
  if (dryRun) {
    log(`would link ${spec} -> ${target}`)
    continue
  }
  rmSync(link, { recursive: true, force: true })
  // Windows 用 junction（不需要管理员权限也能建），其余平台用符号链接
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' })
  } else {
    execFileSync('ln', ['-s', target, link], { stdio: 'ignore' })
  }
  log(`linked ${spec} -> ${target}`)
}

// ── 4. 自检：在插件目录内真正解析一次 peer ────────────────────────
// 不能用裸 `import()`：ESM 的裸说明符按**本文件位置**解析，那样测的是脚本
// 所在目录而不是插件目录，会得到假阳性。这里把探测脚本写进插件目录再执行，
// 让解析基准与运行时一致。
if (!dryRun) {
  const { writeFileSync, unlinkSync } = await import('node:fs')
  const probe = join(pluginDir, `_deploycheck-${process.pid}.mjs`)
  writeFileSync(
    probe,
    `const specs = ${JSON.stringify([...RUNTIME_PEERS, '@earendil-works/pi-ai/api/openai-completions.lazy'])}\n` +
      `for (const s of specs) {\n` +
      `  try { const m = await import(s); console.log('[deploy]    OK  ' + s + '  keys=' + Object.keys(m).length) }\n` +
      `  catch (e) { console.log('[deploy]    FAIL ' + s + '  <' + e.code + '>'); process.exitCode = 1 }\n` +
      `}\n`,
    'utf8',
  )
  try {
    execFileSync(process.execPath, [probe], { stdio: 'inherit', cwd: pluginDir })
  } finally {
    unlinkSync(probe)
  }
}

if (missing > 0) {
  console.error(`[deploy] 有 ${missing} 个 peer 未能补齐`)
  process.exit(1)
}
log(`完成 → ${pluginDir}`)
log('需重启 DSH 后生效')
