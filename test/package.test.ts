/**
 * 包清单与构建产物契约测试。
 *
 * 这些断言保护的是“插件能被 DSH 正确识别与加载”这件事：
 * - package.json 的 exports / files / dsh 字段；
 * - locale 元数据与插件详情文档指针；
 * - 构建产物是否存在、客户端 bundle 是否带 source map 尾注；
 * - 文档是否为中文。
 *
 * 运行：`node --test test/package.test.ts`（需先执行 `npm run build`）
 */

import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

/** 仓库根目录。 */
const ROOT = process.cwd()

/** 读取并解析仓库内的 JSON 文件。 */
async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  const text = await readFile(join(ROOT, relativePath), 'utf8')
  return JSON.parse(text) as Record<string, unknown>
}

/** 判断文件 / 目录是否存在。 */
async function exists(relativePath: string): Promise<boolean> {
  try {
    await access(join(ROOT, relativePath))
    return true
  } catch {
    return false
  }
}

/** 统计字符串中的 CJK 字符数量，用于粗判文档是否为中文。 */
function countCjk(text: string): number {
  return [...text].filter((char) => {
    const code = char.codePointAt(0) ?? 0
    return code >= 0x4e00 && code <= 0x9fff
  }).length
}

test('package.json：基础字段与模块类型', async () => {
  const pkg = await readJson('package.json')

  assert.equal(pkg.name, '@local/session-delete')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.private, true)
  assert.match(String(pkg.version), /^\d+\.\d+\.\d+$/)
  assert.ok(countCjk(String(pkg.description)) > 0, 'description 应为中文')
})

test('package.json：exports 指向构建产物，并保留资源入口', async () => {
  const pkg = await readJson('package.json')
  const exports = pkg.exports as Record<string, unknown>

  assert.deepEqual(exports['.'], {
    types: './lib/index.d.ts',
    default: './lib/index.js',
  })
  assert.equal(exports['./client'], './lib/client.js')
  assert.equal(exports['./locale/*.json'], './locale/*.json')
  assert.equal(exports['./icon'], './icon.svg')
  assert.equal(exports['./package.json'], './package.json')
})

test('package.json：files 覆盖运行所需文件', async () => {
  const pkg = await readJson('package.json')
  const files = pkg.files as readonly string[]

  for (const required of ['lib', 'cordis.patch.yml', 'locale', 'icon.svg', 'README.md', 'docs']) {
    assert.ok(files.includes(required), `files 缺少 ${required}`)
  }
})

test('package.json：dsh 清单保持插件契约', async () => {
  const pkg = await readJson('package.json')
  const dsh = pkg.dsh as {
    bundle: { patch: string }
    client: { platform: string; immediately: boolean; inject: string[] }
  }

  assert.equal(dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(dsh.client.platform, 'web')
  assert.equal(dsh.client.immediately, true)
  assert.deepEqual(dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-context-menu',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-api-session-controller',
  ])
})

test('package.json：脚本与核心开发依赖齐备', async () => {
  const pkg = await readJson('package.json')
  const scripts = pkg.scripts as Record<string, string>
  const devDependencies = pkg.devDependencies as Record<string, string>

  assert.equal(scripts.build, 'node scripts/build.mjs')
  assert.match(scripts.test ?? '', /node --test test\//)
  assert.match(scripts.typecheck ?? '', /tsc -p tsconfig\.json/)
  assert.equal(scripts.check, 'npm run typecheck && npm test')

  for (const name of ['typescript', 'esbuild', 'react', 'react-dom', 'jsdom', '@types/node']) {
    assert.ok(devDependencies[name] !== undefined, `缺少开发依赖 ${name}`)
  }
  assert.ok(pkg.engines !== undefined)
})

test('构建产物：宿主模块与声明文件已生成', async () => {
  for (const file of [
    'lib/index.js',
    'lib/index.d.ts',
    'lib/protocol.js',
    'lib/protocol.d.ts',
    'lib/host/routes.js',
    'lib/host/delete-session.js',
  ]) {
    assert.equal(await exists(file), true, `缺少构建产物 ${file}`)
  }
})

test('构建产物：客户端 bundle 带模块加载器包装与 source map 尾注', async () => {
  assert.equal(await exists('lib/client.js'), true)
  assert.equal(await exists('lib/client.js.map'), true)

  const code = await readFile(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.ok(code.startsWith('window.__ModuleLoader__.load('), 'bundle 应以模块加载器注册开头')
  assert.match(code, /id: '@local\/session-delete'/)
  assert.match(code, /exports\.apply = apply/)
  assert.match(code, /exports\.inject = inject/)
  assert.match(code, /return module\.exports/)
  assert.match(code, /\/\/# sourceMappingURL=client\.js\.map\s*$/)
})

test('构建产物：source map 是宿主可接受的扁平 v3 对象', async () => {
  const mapText = await readFile(join(ROOT, 'lib', 'client.js.map'), 'utf8')
  const map = JSON.parse(mapText) as {
    version: number
    sources: string[]
    names: string[]
    mappings: string
    sections?: unknown
  }

  assert.equal(map.version, 3)
  assert.equal('sections' in map, false, '不能是 indexed source map')
  assert.ok(Array.isArray(map.sources) && map.sources.every((source) => typeof source === 'string'))
  assert.ok(Array.isArray(map.names) && map.names.every((name) => typeof name === 'string'))
  assert.equal(typeof map.mappings, 'string')
})

test('旧入口已移除：只保留 TypeScript 源码与 lib 产物', async () => {
  assert.equal(await exists('index.js'), false, '顶层 index.js 应已删除')
  assert.equal(await exists('client.js'), false, '顶层 client.js 应已删除')
  assert.equal(await exists('src/index.ts'), true)
  assert.equal(await exists('src/client/index.tsx'), true)
})

test('cordis.patch.yml：声明插件挂载点', async () => {
  const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*session-delete/)
  assert.match(patch, /name:\s*'@local\/session-delete'/)
  assert.equal(await exists('icon.svg'), true)
})

test('locale：中英文元数据齐备，中文详情指向中文文档', async () => {
  for (const locale of ['en', 'zh']) {
    const data = await readJson(`locale/${locale}.json`)
    const meta = data.meta as Record<string, string>
    assert.ok(typeof meta.title === 'string' && meta.title.length > 0)
    assert.ok(typeof meta.description === 'string' && meta.description.length > 0)
  }

  const zh = await readJson('locale/zh.json')
  const meta = zh.meta as Record<string, string>
  assert.equal(meta.title, '会话删除')

  const detail = meta.detail
  if (typeof detail !== 'string') assert.fail('zh 需要 meta.detail 指向 Markdown 文档')
  assert.ok(detail.endsWith('.md'), 'meta.detail 应指向 .md 文件')
  assert.equal(await exists(detail), true, `meta.detail 指向的文件不存在：${detail}`)
  const detailText = await readFile(join(ROOT, detail), 'utf8')
  assert.ok(countCjk(detailText) > 100, '插件详情文档应为中文')
})

test('文档：README 与架构/开发文档均为中文', async () => {
  for (const file of ['README.md', 'docs/architecture.md', 'docs/development.md']) {
    assert.equal(await exists(file), true, `缺少文档 ${file}`)
    const text = await readFile(join(ROOT, file), 'utf8')
    assert.ok(countCjk(text) > 200, `${file} 内容过短或不含中文`)
  }

  const readme = await readFile(join(ROOT, 'README.md'), 'utf8')
  assert.match(readme, /npm install/)
  assert.match(readme, /npm run build/)
  assert.match(readme, /删除/)

  // README 中引用的截图应真实存在。
  assert.equal(await exists('docs/images/menu-cold.png'), true)
})

test('TypeScript 工程配置齐备', async () => {
  for (const file of ['tsconfig.json', 'tsconfig.host.json', '.editorconfig', '.gitignore']) {
    assert.equal(await exists(file), true, `缺少配置文件 ${file}`)
  }

  const base = await readJson('tsconfig.json')
  const options = base.compilerOptions as Record<string, unknown>
  assert.equal(options.strict, true)
  assert.equal(options.noEmit, true)

  const host = await readJson('tsconfig.host.json')
  const hostOptions = host.compilerOptions as Record<string, unknown>
  assert.equal(hostOptions.noEmit, false)
  assert.equal(hostOptions.declaration, true)
  assert.equal(hostOptions.outDir, './lib')
})

test('宿主入口：构建后的模块可加载，并以前缀路由注册 API', async () => {
  const entry = (await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)) as {
    name: string
    inject: readonly string[]
    apply(ctx: unknown): void
  }

  assert.equal(entry.name, 'session-delete')
  assert.deepEqual([...entry.inject], [
    'webServer',
    'connection',
    'sessions',
    'sessionPersistence',
    'agents',
    'workspaceRegistry',
    'storageDomain',
    'schedule',
  ])

  const routes: { kind: string; path: string }[] = []
  let effectLabel: string | undefined
  entry.apply({
    webServer: {
      register(route: { kind: string; path: string }) {
        routes.push(route)
        return () => {}
      },
    },
    effect(run: () => unknown, label?: string) {
      effectLabel = label
      run()
    },
  })

  assert.equal(routes.length, 1)
  assert.equal(routes[0]?.kind, 'prefix')
  assert.equal(routes[0]?.path, '/session-delete/api')
  assert.match(effectLabel ?? '', /宿主路由/)
})
