# 开发指南

本文面向修改本插件的开发者，说明环境要求、日常命令、代码约定与调试方法。

## 1. 环境要求

- **Node.js >= 22.18**（本插件直接使用 Node 原生 TypeScript 类型擦除运行测试）；
- **npm**（示例使用 npm；pnpm 亦可，只需把命令替换为对应命令）；
- 一个可用的 DSH 0.2.2 运行时（仅在手工联调插件时必要）。

```bash
npm install
```

> npm 11 可能提示 `esbuild` 的 postinstall 脚本未执行（`allow-scripts` 机制）。esbuild 通过可选平台包提供二进制，通常仍可正常构建；若构建时报“找不到 esbuild 可执行文件”，执行 `npm rebuild esbuild` 或允许该脚本后重装。

## 2. 常用命令

```bash
npm run build        # 清理 lib → tsc 编译宿主半 → esbuild 打包客户端半
npm run typecheck    # 检查 src 与 test 的类型（不产出文件）
npm test             # 构建后运行 node --test test/
npm run check        # typecheck + test（提交前建议执行）
```

单独运行某个测试文件：

```bash
node --test test/host.test.ts
node --test test/client-bundle.test.ts
```

测试依赖构建产物 `lib/client.js` 与 `lib/host/*.js` 存在，所以直接运行前请先 `npm run build`。

## 3. 目录约定

```text
src/index.ts        宿主插件入口（name / inject / apply）
src/protocol.ts     双端共享协议：常量、类型、校验函数
src/host/           宿主半（只跑在 Node 进程）
src/client/         客户端半（只跑在浏览器）
scripts/            构建脚本（ESM，无第三方 CLI 依赖）
test/               Node 内置测试运行器
docs/               文档与截图
lib/                构建产物，不入库
```

- **宿主半禁止导入浏览器 API**，**客户端半禁止导入 Node 内置模块**；需要共享的内容放进 `src/protocol.ts`。
- 客户端半的产物是单个自包含 bundle，`react` 等平台模块由宿主在运行时提供（见 `external` 列表）。

## 4. 编码约定

### 4.1 导入路径

源码之间的相对导入**必须带真实扩展名**（`.ts` / `.tsx`）：

```ts
import { isValidSessionId } from '../protocol.ts'
import { SessionDeleteDialog } from './dialog.tsx'
```

原因有二：

1. `node --test` 直接运行 `.ts` 测试时需要 Node 能解析真实文件（Node 不会把 `.js` 映射到 `.ts`）；
2. `tsconfig` 已开启 `allowImportingTsExtensions` 与 `rewriteRelativeImportExtensions`，`tsc` 产出时会自动改写成 `.js`，esbuild 也能直接解析。

### 4.2 注释与文档

- 所有公开类型、函数、常量都要有**中文 JSDoc**；
- 复杂分支（错误映射、锁的释放、清理顺序）要有说明“为什么这样做”，而不只是“做了什么”；
- 用户可见文案统一放 `src/client/i18n.ts`，不要在组件里写死中文。

### 4.3 类型契约

`src/host/context.ts` 与 `src/client/context.ts` 中的 DSH 服务接口是**手写的最小契约**，注释中标明“契约取自 DSH 0.2.2 运行时”。这样做是为了：

- 不把约 50 个 `@deepseek-ai/*` 包锁进 `devDependencies`；
- 插件仍可作为普通 npm 包安装（profile 安装不会安装 devDependencies）。

升级 DSH 后，若相关服务签名变化，需要同步这两个文件；持久化错误仍按 `error.name` 识别，见 `src/host/delete-session.ts`。

### 4.4 错误与告警

- 返回给客户端的失败必须使用 `protocol.ts` 中已声明的错误码，便于客户端稳定映射文案；
- 清理类操作失败不要抛错，统一收集为 `warnings: string[]`；
- 面向用户的错误消息用中文，技术细节可以拼在冒号之后。

## 5. 构建产物说明

```text
lib/index.js           宿主入口（ESM）
lib/index.d.ts         入口类型声明
lib/protocol.js       共享协议（客户端 bundle 会内联一份）
lib/host/*.js          宿主各模块
lib/client.js          客户端 bundle（带模块加载器包装）
lib/client.js.map      扁平 v3 source map
```

`package.json` 的 `exports`：

- `"."` → `lib/index.js`（含 `types`）；
- `"./client"` → `lib/client.js`；
- `"./locale/*.json"`、`"./icon"`、`"./package.json"` → 资源与清单。

构建脚本会在产物中自检模块加载器包装与 source map 尾注，缺失时以中文错误退出，避免产出宿主无法加载的 bundle。

## 6. 手工联调

### 6.1 安装到当前 profile

```bash
npm run build
```

随后通过 DSH 插件管理器（GUI 的“插件”页，或 `plugin_manager` 工具）执行：

```text
plugin_manager action="install_bundle" target="/home/loong/projects/my/session-delete"
```

卸载使用 `plugin_manager action="remove_bundle" target="@local/session-delete"`。安装后：

- **宿主代码**变更需要重新安装 / 重载 bundle；
- **客户端代码**变更后刷新页面即可（宿主按内容哈希提供 bundle）。

### 6.2 调试客户端

- 浏览器控制台可见宿主返回的错误与清理告警（`session-delete: cleanup warnings`）；
- 网络面板可观察 `GET /session-delete/api/status` 与 `POST /session-delete/api/delete`；
- 若菜单项不出现，先手动请求 `/status`，确认 `exists === true` 且 `live === false`。

### 6.3 调试宿主

宿主半的错误会被兜底为 `500 internal-error`，响应体含 `message`。必要时在 `src/host/routes.ts` 的 `routeRequest` 外层 `catch` 临时打印堆栈，或直接对本地 DSH 进程日志排错。

## 7. 测试编写提示

- 宿主测试使用真实临时目录（`node:fs/promises.mkdtemp`）验证删除副作用，不要 mock `fs`；
- 客户端测试执行的是**构建产物** `lib/client.js`，不是 `src/client/**`，因此测试前必须构建；
- 组件测试使用真实 `react` / `react-dom` 与 jsdom，`FakeModal` 仅模拟 `Modal` 的渲染槽位，避免断言依赖 DSH 私有实现；
- 断言尽量面向行为（菜单是否出现、是否发出请求、是否关闭），而不是内部状态。

## 8. 常见问题

**Q：`npm test` 报 `Cannot find module '.../lib/client.js'`？**
A：先执行 `npm run build`；`npm test` 已内置构建步骤，单独跑 `node --test` 时需要手动构建。

**Q：修改了 `src/client/**`，页面没有变化？**
A：客户端 bundle 需要重新构建（`npm run build`）后刷新页面；宿主会按内容哈希选择新 bundle。

**Q：修改了 `src/host/**`，接口 404 或行为没变？**
A：需要重新安装 / 重载 bundle，宿主进程才会加载新的 `lib/index.js`。

**Q：浏览器控制台出现 `session-delete: cleanup warnings`？**
A：说明会话文件已删除，但某些元数据清理失败（例如归档标记所在服务报错）。按告警文本定位对应服务即可，主流程不受影响。
