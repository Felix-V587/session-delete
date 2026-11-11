# 架构说明

本文描述 `@local/session-delete` 的内部结构与设计取舍。面向需要维护或二次开发本插件的读者。

## 1. 总体结构

插件由两个独立加载的半部分组成，它们通过同一个 HTTP 前缀通信：

```text
浏览器（DSH Web）
  ├─ 客户端半 lib/client.js
  │    ├─ 注册 context menu 贡献（target: session）
  │    ├─ 运行时查询 /status 决定是否显示“删除会话…”
  │    └─ 两步确认对话框 → POST /delete
  │
  └─ fetch ──► /session-delete/api/*
                    │
DSH 宿主进程         ▼
  └─ 宿主半 lib/index.js
       ├─ registerRoutes：前缀路由（webServer）
       ├─ routeRequest：鉴权、解析、分发
       ├─ inspectSession：会话概览
       └─ deleteSession：写锁 + 文件删除 + 元数据清理
```

- **宿主半**使用 Cordis 插件约定：导出 `name`、`inject`、`apply(ctx)`。`apply` 中通过 `ctx.effect()` 注册路由，插件卸载时路由会随之移除。
- **客户端半**以 DSH 模块加载器格式交付：`window.__ModuleLoader__.load({ id, factory })`，在 `factory(require)` 中返回 `apply` / `inject`。它只依赖平台提供的 `react`、`react/jsx-runtime` 与 `@deepseek-ai/dsh-client-ui-primitives`。

## 2. 源码模块划分

### 2.1 共享层

`src/protocol.ts` 是双端共享的“协议层”，浏览器安全（不导入任何 Node 内置模块）：

- 常量：`ROUTE_PREFIX`、`API_ROOT`、`BODY_LIMIT`、`SESSION_ID_PATTERN`；
- 类型：`SessionSummary`、`DeletePayload`、`KnownFailureCode` 等；
- 运行时校验：`isValidSessionId`、`isRecord`，以及 `parseStatusPayload` / `parseDeletePayload` 等响应解析函数。

客户端会把 HTTP 响应交给解析函数处理，宿主也复用同一套类型，从源头避免双端字段漂移。

### 2.2 宿主半（src/host）

| 文件 | 职责 |
| --- | --- |
| `context.ts` | 手写的 DSH 服务契约类型（`webServer`、`connection`、`sessionPersistence` 等） |
| `routes.ts` | 注册前缀路由；`routeRequest` 完成鉴权、路径分发、错误兜底 |
| `inspect.ts` | 读取会话快照并计算 `exists` / `live` / `archived` 等概览字段 |
| `delete-session.ts` | 删除主流程：写锁、文件删除、告警收集、失败码映射 |
| `cleanup.ts` | 尽力而为的元数据清理（归档、置顶、工作区分组、投影缓存、定时任务） |
| `http.ts` | 请求体读取（带大小上限）与 JSON 响应写出 |
| `util.ts` | 安全的错误消息 / 错误名读取 |

`src/index.ts` 只做编排：声明 `name`、`inject`，在 `apply` 中注册路由。

### 2.3 客户端半（src/client）

| 文件 | 职责 |
| --- | --- |
| `index.tsx` | 插件入口：注册词典、绑定翻译、创建控制器、注册菜单 |
| `menu.ts` | 上下文菜单贡献；根据 `/status` 结果决定是否显示动作 |
| `dialog.tsx` | 两步确认对话框（风险说明 → 最后确认） |
| `overlay.tsx` | `ConfirmController`：管理插槽注册、打开 / 关闭与生命周期 |
| `api.ts` | `fetchStatus` / `requestDelete` / 失败码到本地化文案的映射 |
| `i18n.ts` | en / zh 词典、占位符插值、翻译器工厂 |
| `styles.ts` | 与 DSH 设计令牌对齐的内联样式 |
| `context.ts` | 手写的客户端服务契约类型 |

## 3. 请求处理流程

### 3.1 GET /status

1. `routeRequest` 先调用 `connection.requestRejection(req)`，返回 401 / 403 时直接拒绝。
2. 解析 `sessionId`，用 `SESSION_ID_PATTERN` 校验。
3. `inspectSession` 读取 `sessionPersistence.stat(id)` 快照：
   - `exists`：快照是否存在；
   - `live`：`sessions.get(id)` 或 `agents.get(id)` 是否命中；
   - `archived`：是否在 `workspaceRegistry.archivedSessionIds` 中；
   - `formatStatus` / `eventCount` / `sizeBytes`：来自快照，缺失时为 `null`。
4. 返回 `{ ok: true, session }`。

客户端只在 `status !== null && status.exists === true && status.live === false` 时显示菜单项，因此活跃会话根本不会看到删除入口。

### 3.2 POST /delete

1. 同样的连接层鉴权与 id 校验。
2. 读取请求体：上限 8 KB；超限返回 413，非法 JSON 返回 400。
3. 进入 `deleteSession`：

```text
inspect → 不存在？ 404 not-found
        → 活跃？   409 live
        → open(write)
             ├─ SessionAlreadyOwnedError → 409 live（另一个写入者持有锁）
             ├─ SessionPersistenceNotFoundError → 404
             ├─ SessionFormatUnsupportedError → 422
             └─ 其它 → 500 claim-failed
        → stat 取日志路径
             ├─ 无 location → 告警“未找到会话日志文件，仅清理元数据。”
             └─ 有 location → rm(日志文件) → rm(会话目录, recursive)
        → close 释放写锁（失败仅告警）
        → cleanupMetadata（5 步，失败仅告警）
        → stat 复核（仍存在则提示刷新）
        → 200 { ok: true, deleted, warnings }
```

## 4. 关键设计决策

### 4.1 先删日志、再删目录

如果中途崩溃，留下一个没有 generation log 的目录会被扫描器跳过；反之先删目录会留下无法定位的日志文件。先删日志还能保证“会话可见性”与“磁盘占用”在同一步失效。

### 4.2 删除期间持有写锁

`sessionPersistence.open(id, 'write')` 是原子抢锁。持锁期间删除目录，可以阻止其它写入者在删除过程中继续追加事件或重建文件。

### 4.3 按错误名而不是 `instanceof` 识别持久化错误

宿主半不直接依赖 `@deepseek-ai/dsh-session-persistence` 的运行时类（避免版本锁定与 peer 依赖复杂化），而是读取 `error.name` 字符串：`SessionAlreadyOwnedError`、`SessionPersistenceNotFoundError`、`SessionFormatUnsupportedError`。这与 DSH 0.2.2 运行时的实际行为一致；升级 DSH 时只需核对这里的名字。

### 4.4 元数据清理“尽力而为”

归档标记、置顶、工作区分组、投影缓存、定时任务分散在多个服务中，任何一步失败都不应让“文件已删除”的事实变成 500。因此 `cleanupMetadata` 为每一步捕获异常并转成中文告警，随成功响应返回。客户端在控制台打印这些告警，但不打扰用户。

### 4.5 告警与错误分离

- **错误**：删除没有发生（或日志文件删不掉），返回非 2xx + 稳定错误码；
- **告警**：删除已发生，但清理或复核有异常，返回 200 + `warnings`。

这样客户端可以准确区分“失败请重试”和“成功但有残留”。

### 4.6 双端共享协议解析

`protocol.ts` 中的 `parseStatusPayload` / `parseDeletePayload` 对未知 JSON 做结构校验，客户端不信任任何响应形状。新增字段时先改类型与解析器，再改两端消费代码。

## 5. 客户端交互细节

- 菜单贡献的 `resolve(target, signal)` 在每次打开菜单时调用，内部 `fetch` 带上 `AbortSignal`，菜单关闭即取消请求。
- 对话框通过 `shell.overlay` 插槽注册，`order: 60` 保证位于常规浮层之上；`locale: NS` 让宿主注入对应语言的 `t` 函数。
- `ConfirmController` 持有唯一 pending 请求：再次打开会先关闭旧对话框，避免多个遮罩叠加。
- 删除成功后先 `onClose()` 再触发 `onDeleted(warnings)`，随后刷新会话列表；刷新失败被静默吞掉（列表仍可通过手动刷新恢复）。
- 失败时对话框保持打开，用 `role="alert"` 展示本地化错误，用户可以取消或重试。

## 6. 构建与产物契约

- `scripts/build.mjs`：清空 `lib/` → 以 `tsconfig.host.json` 运行 `tsc`（输出 ESM + `.d.ts`）→ 调用 esbuild 打包客户端。
- `scripts/build-client.mjs`：
  - `format: 'cjs'`，`platform: 'browser'`，`jsx: 'automatic'`；
  - `external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']`；
  - 用 `banner` 打开 `window.__ModuleLoader__.load(...)`，用 `footer` 补齐 `exports.apply` / `exports.inject` / `return module.exports`；
  - 开启 `sourcemap`，由 esbuild 生成**扁平 v3** source map 并追加 `//# sourceMappingURL=client.js.map`。
- DSH 宿主只接受扁平 v3 map（含 `sections` 的 indexed map 会被拒绝），因此不使用任何手写 section 拼接。

## 7. 测试策略

| 测试 | 覆盖点 |
| --- | --- |
| `test/protocol.test.ts` | 常量、id 校验、响应解析与告警过滤 |
| `test/host.test.ts` | 真实 `http.createServer` 上挂 `routeRequest`，覆盖全部成功 / 失败分支与文件系统副作用 |
| `test/client-bundle.test.ts` | 用 jsdom + 真实 React 执行构建后的 `lib/client.js`，验证菜单 gating、两步对话框、成功 / 失败路径 |
| `test/package.test.ts` | 包清单、构建产物、source map 形态、locale 元数据、文档语言 |

宿主测试不启动完整 DSH，而是注入 mock 的 `HostContext`；客户端测试也不依赖真实宿主，而是伪造 `window.__ModuleLoader__` 与 `ClientContext`。两者都以“契约”而非“实现细节”为断言对象。
