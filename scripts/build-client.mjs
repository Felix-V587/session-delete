/**
 * 客户端 bundle 构建器。
 *
 * DSH 的客户端插件并不是普通的 ESM 模块，而是一个“lazy CJS factory”：
 * 宿主先执行 bundle 顶层代码，只为了拿到 `window.__ModuleLoader__.load({ id, factory })`
 * 注册的 factory；真正 materialize 时宿主才调用 `factory(require)`，用返回值里的
 * `apply` / `inject` 激活插件。
 *
 * 因此这里不能直接让 esbuild 输出普通模块，而是用 banner/footer 手工包一层外壳：
 *   - banner 打开 ModuleLoader 调用与 factory，并保留惰性 require；
 *   - footer 补上 exports.apply / exports.inject 与 return module.exports。
 * 这样做的好处是 source map 由 esbuild 一次性生成（flat v3），偏移完全正确；
 * DSH 宿主只接受 flat source map，带 `sections` 的 indexed map 会被拒绝。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { build } from 'esbuild'

/** 客户端入口（TSX，JSX 使用 automatic runtime）。 */
export const CLIENT_ENTRY = 'src/client/index.tsx'

/** 客户端 bundle 产物路径（相对工程根目录）。 */
export const CLIENT_OUTFILE = 'lib/client.js'

/**
 * 外壳开头：与 DSH 0.2.2-rc.1 官方客户端 bundle 的形态保持一致。
 * 注意 `'use strict'` 放在 factory 内部——如果放到 banner 之外，
 * 它就不再是文件的第一条语句，严格模式会失效。
 */
const banner = `window.__ModuleLoader__.load({
\tid: '@local/session-delete',
\tfactory: (require) => {
\t\t'use strict';
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
`

/**
 * 外壳结尾：esbuild 在 format=cjs 时会把 module.exports 指向自己的导出对象，
 * 这里再显式挂一次 apply/inject，保证两种导出路径都可用。
 */
const footer = `\n\t\texports.apply = apply;
\t\texports.inject = inject;
\t\treturn module.exports;
\t}
});
`

/**
 * 构建客户端 bundle，并校验产物符合 DSH ModuleLoader 契约。
 *
 * @param {{ projectRoot: string }} options 构建参数
 * @returns {Promise<void>}
 */
export async function buildClientBundle({ projectRoot }) {
  const outfile = path.join(projectRoot, CLIENT_OUTFILE)

  await build({
    absWorkingDir: projectRoot,
    entryPoints: [CLIENT_ENTRY],
    outfile,
    // 单文件、CJS、浏览器平台：产物会在宿主提供的 `require` 环境里执行。
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    // automatic JSX runtime 会被 DSH 平台 baseline 提供，因此保持 external。
    jsx: 'automatic',
    charset: 'utf8',
    legalComments: 'none',
    // 这三个依赖由宿主在 materialize 时注入，不能打进 bundle。
    external: [
      'react',
      'react/jsx-runtime',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
    sourcemap: true,
    logLevel: 'info',
    banner: { js: banner },
    footer: { js: footer },
  })

  // 产物自检：防止 banner/footer 配置漂移导致宿主静默加载失败。
  const output = readFileSync(outfile, 'utf8')
  const requiredMarkers = [
    'window.__ModuleLoader__.load',
    "id: '@local/session-delete'",
    'exports.apply = apply',
    'exports.inject = inject',
    'return module.exports',
  ]
  for (const marker of requiredMarkers) {
    if (!output.includes(marker)) {
      throw new Error(`客户端 bundle 缺少约定片段：${marker}（产物：${outfile}）`)
    }
  }

  // DSH 宿主只解析 flat source map，这里顺带确认尾部注释确实存在。
  if (!output.includes('//# sourceMappingURL=client.js.map')) {
    throw new Error(`客户端 bundle 缺少 source map 尾注（产物：${outfile}）`)
  }

  console.log('客户端 bundle 已生成：lib/client.js（含 source map）')
}
