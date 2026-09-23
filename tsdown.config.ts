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

/**
 * client 半的外部依赖：由宿主模块表经 require 注入，不打进产物。
 *
 * 注意：react / react/jsx-runtime **不能**写进 external —— rolldown 对 external 的
 * CJS 默认导入会生成 `__toESM(require("react"), 1)` 包装，`__toESM` 拿不到具名导出
 * 时退回 `{}`，`react.useState` 变 undefined，渲染期抛
 * `Cannot read properties of null (reading 'useState')`。
 *
 * 正确做法（对齐 dsh-workbuddy-connect/lib/client.js）：
 * react 由 banner 里手写 `const react = require("react")` 注入为模块内变量，
 * 源码里 `declare const react` 只做类型引用，不写 import。这样产物是
 * 无 `__toESM` 包装的裸 `require`，`react.useState` 直接可用。
 */
const CLIENT_EXTERNAL: string[] = []

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
      //
      // react / react/jsx-runtime 在此以裸 require 注入为模块内变量，避免 rolldown
      // 对 external 的 `__toESM` 包装（那会让 react.useState 变 undefined）。
      return `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tconst react = require("react");\n\t\tconst react_jsx_runtime = require("react/jsx-runtime");`
    },
    footer: () => {
      return `\t\treturn module.exports;\n\t}\n});`
    },
  },
])
