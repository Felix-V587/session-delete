/**
 * 统一构建入口。
 *
 * 构建分两步：
 *   1. 用 tsc 把宿主半（src/index.ts、src/protocol.ts、src/host/**）编译到 lib/，
 *      同时产出 .d.ts 与 source map，供 DSH 宿主按 Node ESM 方式加载；
 *   2. 用 esbuild 把客户端半（src/client/index.tsx）打成单文件 CJS bundle：lib/client.js。
 *
 * 两步都完成后 lib/ 才是“可发布”状态：package.json 的 exports 指到这里。
 */

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildClientBundle } from './build-client.mjs'

/** 工程根目录（scripts/ 的上一级）。 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 同步执行一个子进程，失败时抛出带中文说明的错误。
 *
 * @param {string} command 可执行文件
 * @param {string[]} args 参数列表
 */
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.error !== undefined) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 执行失败（退出码 ${String(result.status)}）`)
  }
}

async function main() {
  // 每次全量重建，避免残留的旧声明文件或旧的客户端 bundle 混进产物。
  rmSync(path.join(projectRoot, 'lib'), { recursive: true, force: true })

  const tscBin = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  // 直接用当前 Node 运行 tsc 的 JS 入口，不依赖 PATH 里是否存在全局 tsc。
  run(process.execPath, [tscBin, '-p', 'tsconfig.host.json'])

  await buildClientBundle({ projectRoot })

  console.log('构建完成：lib/index.js、lib/client.js 及相关声明文件已生成。')
}

await main()
