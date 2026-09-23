import { defineConfig } from 'tsdown'

/**
 * host 半 (src/index.ts) 保持 ESM —— 在 Node 侧由 cordis 正常 import。
 * client 半 (src/client/index.tsx) 必须产出 DSH 客户端模块格式：
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *
 * 这是 DSH 的 client 模块系统（dsh-client-modules）约定的产物形状：
 * bundle 执行时只「登记」一个 factory，工厂体在首次 require 时物化，
 * 其内部通过注入的 require 解析 react 等外部依赖。
 *
 * 关键：client 产物**不能**是原生 ESM。若用 format: 'esm' 产出顶层
 * `import React from "react"`，会被 concat 进非 module 的 combo script，
 * 浏览器抛 "Cannot use import statement outside a module"，连带把同批
 * 其它插件的 client bundle 一起炸掉（正是本次线上报错的根因）。
 *
 * 参考：deepseek-harness packages/client/tsdown.client.ts 的 clientBundle
 * preset，以及 dsh-workbuddy-connect/lib/client.js 的实际产物头尾。
 */

const CLIENT_ID = 'dsh-llamacpp-connect'

/** client 半的外部依赖：由宿主模块表经 require 注入，不打进产物 */
const CLIENT_EXTERNAL = [
  'react',
  'react/jsx-runtime',
]

export default defineConfig([
  // ---- host 半：ESM ----
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: 'esm',
    outExtensions: () => ({ js: '.js' }),
    dts: true,
    clean: true,
    deps: {
      // 宿主提供这些依赖，不打进产物
      neverBundle: [
        /^@deepseek-ai\//,
        /^@earendil-works\//,
        'react',
        'react/jsx-runtime',
      ],
    },
  },
  // ---- client 半：DSH 客户端模块格式 ----
  {
    entry: ['src/client/index.tsx'],
    outDir: 'lib/client',
    format: 'cjs',
    outExtensions: () => ({ js: '.js' }),
    dts: true,
    clean: false,
    external: CLIENT_EXTERNAL,
    banner: (chunk) => {
      // 入口 chunk 是主 factory；多 chunk 时用 chunk: 字段（本插件单入口，仅主）
      // 必须在 factory 体内声明 module/exports，产物里的 exports.xxx / module.exports
      // 才能解析（与 dsh-workbuddy-connect/lib/client.js 头部一致）。
      return `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;`
    },
    footer: () => {
      return `\t\treturn module.exports;\n\t}\n});`
    },
  },
])
