import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/client/index.tsx'],
  outDir: 'lib',
  format: 'esm',
  // 产出 .js 而非 .mjs，与 package.json 的 exports 声明一致
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
})
