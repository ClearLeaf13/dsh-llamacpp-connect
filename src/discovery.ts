/**
 * 定位本地 llama.cpp 管理器。
 *
 * 管理器把它维护的模型配置写在 `%APPDATA%\llm-manager\models.json`，
 * 并在启动时把控制 API 的端口与令牌写到同目录。
 *
 * 本模块只做「找到并读出这些事实」，不含任何业务判断，便于单测注入。
 *
 * @module dsh-llamacpp-connect/discovery
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFile, access } from 'node:fs/promises'

/** 管理器在用户数据目录里维护的文件名 */
export const MANAGER_FILES = {
  models: 'models.json',
  token: 'api-token.txt',
  port: 'api-port.txt',
} as const

/** DSH 环境里 Electron 的 app.getPath('userData') 在 Windows 上落在这里 */
const APPDATA_DIRNAME = 'llm-manager'

/**
 * 管理器用户数据目录的候选位置，按优先级排列。
 *
 * Windows 上 `%APPDATA%` 即 `~/AppData/Roaming`；其它平台留出等价位置，
 * 但管理器当前只发 Windows 版，非 Windows 上大概率找不到，属预期。
 */
export function candidateDirs(): string[] {
  const home = homedir()
  const fromEnv = process.env.APPDATA
  const list = [
    fromEnv ? join(fromEnv, APPDATA_DIRNAME) : undefined,
    join(home, 'AppData', 'Roaming', APPDATA_DIRNAME),
    join(home, '.config', APPDATA_DIRNAME),
    join(home, 'Library', 'Application Support', APPDATA_DIRNAME),
  ].filter((x): x is string => Boolean(x))

  // 去重并归一，避免同一路径重复探测
  return [...new Set(list.map((p) => resolve(p)))]
}

/** 文件是否可读 */
async function readable(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export interface ManagerLocation {
  /** 管理器数据目录 */
  dir: string
  /** 模型配置文件路径 */
  modelsPath: string
  /** 控制 API 端口；管理器未运行或旧版本时为 undefined */
  apiPort?: number
  /** 控制 API 令牌；缺失时无法自动启停 */
  apiToken?: string
}

/**
 * 探测管理器位置。
 *
 * 找到 `models.json` 即视为已安装；控制 API 的端口/令牌独立探测，
 * 因为它们只在管理器运行时才存在，且旧版本管理器根本不写这两个文件。
 *
 * @returns 位置信息；未安装时返回 undefined
 */
export async function locateManager(
  dirs: string[] = candidateDirs(),
): Promise<ManagerLocation | undefined> {
  for (const dir of dirs) {
    const modelsPath = join(dir, MANAGER_FILES.models)
    if (!(await readable(modelsPath))) continue

    const location: ManagerLocation = { dir, modelsPath }

    // 控制 API 是增强能力，探测失败不影响基础同步
    const portPath = join(dir, MANAGER_FILES.port)
    const tokenPath = join(dir, MANAGER_FILES.token)
    if (await readable(portPath)) {
      try {
        const raw = (await readFile(portPath, 'utf8')).trim()
        const port = Number.parseInt(raw, 10)
        // 只接受合法端口，避免读到半截文件时把 NaN 当端口用
        if (Number.isInteger(port) && port > 0 && port < 65536) {
          location.apiPort = port
        }
      } catch {
        /* 读失败即视为无控制 API */
      }
    }
    if (location.apiPort !== undefined && (await readable(tokenPath))) {
      try {
        const token = (await readFile(tokenPath, 'utf8')).trim()
        if (token.length > 0) location.apiToken = token
      } catch {
        /* 同上 */
      }
    }

    return location
  }

  return undefined
}

/** 控制 API 是否可用（端口与令牌都齐） */
export function controlApiAvailable(loc: ManagerLocation | undefined): boolean {
  return Boolean(loc?.apiPort && loc?.apiToken)
}
