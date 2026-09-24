import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateManager, controlApiAvailable, MANAGER_FILES } from '../src/discovery.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-llm-disc-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 写入一个最小可用的 models.json */
async function writeModels(d: string, models: unknown[] = []) {
  await mkdir(d, { recursive: true })
  await writeFile(join(d, MANAGER_FILES.models), JSON.stringify({ version: 1, models }), 'utf8')
}

describe('locateManager', () => {
  it('找到含 models.json 的目录', async () => {
    await writeModels(dir)
    const loc = await locateManager([dir])
    expect(loc).toBeDefined()
    expect(loc!.dir).toBe(dir)
    expect(loc!.modelsPath).toBe(join(dir, MANAGER_FILES.models))
  })

  it('目录不存在时返回 undefined', async () => {
    const loc = await locateManager([join(dir, 'nope')])
    expect(loc).toBeUndefined()
  })

  it('目录存在但没有 models.json 时返回 undefined', async () => {
    await mkdir(dir, { recursive: true })
    const loc = await locateManager([dir])
    expect(loc).toBeUndefined()
  })

  it('按候选顺序取第一个命中的', async () => {
    const empty = join(dir, 'empty')
    const real = join(dir, 'real')
    await mkdir(empty, { recursive: true })
    await writeModels(real)

    const loc = await locateManager([empty, real])
    expect(loc!.dir).toBe(real)
  })

  it('无控制接口文件时只返回基础位置', async () => {
    await writeModels(dir)
    const loc = await locateManager([dir])
    expect(loc!.apiPort).toBeUndefined()
    expect(loc!.apiToken).toBeUndefined()
    expect(controlApiAvailable(loc)).toBe(false)
  })

  it('读齐端口与令牌时标记控制接口可用', async () => {
    await writeModels(dir)
    await writeFile(join(dir, MANAGER_FILES.port), '8765', 'utf8')
    await writeFile(join(dir, MANAGER_FILES.token), 'abc123', 'utf8')

    const loc = await locateManager([dir])
    expect(loc!.apiPort).toBe(8765)
    expect(loc!.apiToken).toBe('abc123')
    expect(controlApiAvailable(loc)).toBe(true)
  })

  it('端口文件内容非法时忽略', async () => {
    await writeModels(dir)
    await writeFile(join(dir, MANAGER_FILES.port), 'not-a-port', 'utf8')
    await writeFile(join(dir, MANAGER_FILES.token), 'abc', 'utf8')

    const loc = await locateManager([dir])
    expect(loc!.apiPort).toBeUndefined()
    expect(controlApiAvailable(loc)).toBe(false)
  })

  it('端口越界时忽略', async () => {
    await writeModels(dir)
    await writeFile(join(dir, MANAGER_FILES.port), '70000', 'utf8')
    await writeFile(join(dir, MANAGER_FILES.token), 'abc', 'utf8')

    const loc = await locateManager([dir])
    expect(loc!.apiPort).toBeUndefined()
  })

  it('只有端口没有令牌时不算可用', async () => {
    await writeModels(dir)
    await writeFile(join(dir, MANAGER_FILES.port), '8765', 'utf8')

    const loc = await locateManager([dir])
    expect(loc!.apiPort).toBe(8765)
    expect(loc!.apiToken).toBeUndefined()
    expect(controlApiAvailable(loc)).toBe(false)
  })

  it('空令牌文件不算可用', async () => {
    await writeModels(dir)
    await writeFile(join(dir, MANAGER_FILES.port), '8765', 'utf8')
    await writeFile(join(dir, MANAGER_FILES.token), '   \n', 'utf8')

    const loc = await locateManager([dir])
    expect(controlApiAvailable(loc)).toBe(false)
  })
})
