# 参与 Kindly Web 开发

Kindly Web 是一款 Chrome 扩展（Manifest V3）：劫持 B 站评论区与弹幕接口，将攻击性表达经用户自配的 LLM API 改写为友善、理性的表达。本文件面向**人类贡献者**，覆盖开发环境、代码结构、代码约定与常见任务的完整步骤。更深的架构设计说明见仓库根目录的 `AGENTS.md`。

- 安全不变量：**LLM 请求只发生在 Service Worker**（`entrypoints/background.ts`）。API Key 永不进入页面进程，内容脚本只收到改写结果的 DTO。
- 技术栈：**WXT 0.21 + 原生 TypeScript**（无 UI 框架），MV3。
- 要求：**Node ≥ 22 + pnpm**（不要使用 npm/yarn）。

---

## 目录

1. [开发环境](#开发环境)
2. [项目结构](#项目结构)
3. [架构速览](#架构速览)
4. [代码约定](#代码约定)
5. [常见任务](#常见任务)
6. [测试与验证](#测试与验证)
7. [提交 PR 前检查清单](#提交-pr-前检查清单)

---

## 开发环境

```bash
pnpm install     # postinstall 自动执行 wxt prepare（生成 .wxt/ 类型）
pnpm dev         # 开发服务器 + HMR，自动启动 Chrome 加载扩展
pnpm build       # 生产构建 → .output/chrome-mv3/
pnpm zip         # 构建 + 打包 → .output/kindly-web-<version>-chrome.zip
pnpm typecheck   # tsc --noEmit（strict）—— 合并前的强制门槛
```

- 开发构建输出在 `.output/chrome-mv3-dev`，生产构建在 `.output/chrome-mv3`。
- 品牌版 Chrome 137+ 会忽略 `--load-extension`，请使用 **Chrome for Testing** 或手动在 `chrome://extensions` 以开发者模式加载 `.output/chrome-mv3-dev`。
- 新增 entrypoint 后无需手动操作，`dev`/`build` 会自动重新生成 `.wxt/` 类型。

### 开发用测试钩子（仅 development 模式）

| 端口 | 用途 | 注入点 |
|---|---|---|
| `localhost:8787` | B 站风格 DOM 的 fixture 页面，验证内容脚本 | 内容脚本 `matches`（`import.meta.env.DEV` 条件展开） |
| `localhost:8788` | mock LLM 服务（OpenAI 兼容，支持 `?fail=auth\|429\|timeout\|500\|parse` 故障注入） | `wxt.config.ts` 的 host_permissions |

两个服务器位于 `/tmp/kw-test/`。**这些地址绝不能泄漏进生产构建**——每次构建后检查 manifest（见[测试与验证](#测试与验证)）。

---

## 项目结构

```
entrypoints/                 WXT 入口（构建期约定驱动）
├── background.ts            Service Worker：队列、重试、缓存、连接测试、多 Key 轮换
├── bilibili-danmaku.content.ts  主世界劫持层薄壳（world: MAIN, document_start）
├── bilibili.content.ts      isolated 世界结果应用层薄壳（document_idle）
├── popup/                   popup 页面（index.html + main.ts + style.css）
├── onboarding/              首次引导页
└── options/                 设置页
lib/                         跨端共享、与浏览器无关的模块（经 @/lib/... 导入）
├── hijack-engine.ts         通用主世界 API 劫持引擎（fetch/XHR 包装、评论放行、弹幕管道）——站点无关
├── rewrite-ui.ts            通用 isolated 结果应用器（注册表、替换/气泡/角标、observer 兜底）——站点无关
├── sites/
│   ├── types.ts             SiteAdapter 契约（接入新平台的唯一接口）
│   ├── registry.ts          站点注册表 SITE_ADAPTERS
│   ├── bilibili.ts          B 站评论适配器（URL 匹配/提取/DOM 定位/选择器）
│   └── bilibili-danmaku.ts  B 站弹幕适配器（protobuf 编解码、响应重建、屏上替换）
├── bridge.ts                main world ↔ 扩展的 postMessage 桥（ready 握手 + 未就绪排队）
├── messages.ts              完整消息协议（KW_* 判别联合）——动消息先看这里
├── config.ts                KindlyConfig 结构 + 默认值 + Provider 预置表 + 版本迁移链 + 多 Key 解析
├── response-parser.ts       LLM 输出解析（纯函数，宽松 JSON 提取）——保持框架无关
├── prompt.ts                提示词构造
├── cache.ts                 改写缓存（sha256 + 签名失效）
├── errors.ts                错误分类 RewriteReason
├── i18n.ts                  全部 UI 文案（t(key, vars)）
└── bilibili.css             内容脚本注入样式（kw- 前缀）
wxt.config.ts                Manifest 装配：storage 权限、静态 host_permissions、optional_host_permissions
public/icon/                 图标资源
```

---

## 架构速览

```
B 站页面 / 播放器 iframe ──> bilibili-danmaku.content.ts（world: MAIN, document_start）
   包装 window.fetch + XHR，按 URL 分流：
   ├─ 评论接口  → 零阻塞放行（页面先渲染原文）→ 提取 rpid/message
   │              → KW_REWRITE_COMMENTS → SW 改写 → 结果经桥回传
   │              → bilibili.content.ts（ISOLATED）按 seq/rpid 定位 DOM 替换
   └─ 弹幕接口  → 先放行（弹幕立即显示，绝不等待）→ 全量分批并发送 SW
                   → KW_REWRITE_BATCH_RESULT 聚合回发 → 屏上替换 + 缓存
popup / onboarding / options ──KW_SET_ENABLED / KW_CONFIG_CHANGED / KW_TEST_CONNECTION / KW_GET_STATUS──> SW
```

核心概念（动相关代码前必读）：

- **两个内容脚本、两个 world**：`bilibili-danmaku.content.ts`（`world: 'MAIN'`，劫持层，`runAt: document_start` 须先于页面业务脚本完成包装）；`bilibili.content.ts`（`world: 'ISOLATED'`，结果应用层）。WXT 入口名冲突规则：两个脚本文件名**首段必须不同**（`bilibili` vs `bilibili-danmaku`）。
- **MAIN world 没有 `chrome.runtime`**（Chrome 137+ Self-XSS 防护）：主世界劫持层不能直接 `sendMessage`，一切通信走 `lib/bridge.ts` 的 postMessage 桥（isolated 侧 `startBridge()` 转发，含 ready 握手 + 未就绪消息队列）。
- **评论异步语义**：响应原样放行 → 异步改写 → 结果按 **seq**（接口 replies 顺序 ↔ DOM 内 thread 顺序）定位替换；结果先于 DOM 渲染时用 `pendingResults` 队列重试 6s。
- **弹幕异步语义**：先放行 → 全量分批（`DM_BATCH_SIZE` 条/批）并发送 SW → 结果屏上替换；`danmakuMaxTotal` 阈值超限整批放行原文（打"跳"角标）。
- **消息协议**：所有 `KW_*` 消息是 `lib/messages.ts` 中的判别联合。DOM 节点永不跨消息——CS 侧维护 `Map<id, HTMLElement>` 注册表 + `data-kw-id` 属性，消息只传 id。
- **存储分层**：`storage.sync` 的 `config`（非敏感偏好，含 `version` 供读时迁移）vs `storage.local` 的 `apiKey`（敏感，逗号分隔多 Key）、`kwCache`（sha256 缓存）、`kwQueueMirror`（SW 队列持久化，唤醒恢复）。
- **错误分类**：`RewriteReason = auth | rate_limited | timeout | network | parse | empty`。任何失败必须降级为**显示原文**，错误信息经 `detail` 携带（截断 200 字符，永不含 Key）。

---

## 代码约定

- **TypeScript strict**：`strict + noUnusedLocals + noUnusedParameters`；类型导入用 `import type`；`unknown` 先收窄再使用；`noUncheckedIndexedAccess` 已开启——数组/Map 索引要先判空（`if (!entry) return;`）。
- **WXT 入口约定**：`background.ts` → SW；内容脚本必须命名为 `*.content.ts`（不要建 `content-scripts/` 目录）；页面是含 `index.html` 的目录。`matches`/`runAt` 声明在 `defineContentScript` 内；内容脚本 CSS 从 TS 文件 import，构建期抽取进 manifest。
- **导入**：`browser` 来自 `wxt/browser`（运行时即 chrome）；共享代码用 `@/lib/...` 别名。`lib/sites/` 内部相对导入要带显式 `.ts` 后缀，保持纯逻辑可用 Node 直接跑。
- **异步**：fire-and-forget 用 `void` 前缀（`void notifyTab(...)`）；`onMessage` 监听器同步处理返回 `false`，异步返回 `true` + `sendResponse`；内容脚本捕获 `Extension context invalidated` 并自清理（`restoreAll()`）。
- **错误**：永不跨消息边界抛异常——分类进 `RewriteReason`，可附 `detail`（provider 错误文本，截 200 字符，不含 Key）。任何失败都降级为原文。
- **命名**：消息类型 `KW_*`（单一来源：`lib/messages.ts`，新消息先加那里）；存储键 `kw*`；注入 CSS 类 `kw-*`；JSDoc 用中文。
- **内容脚本**：劫持包装 `window.fetch`/`XMLHttpRequest` 后**绝不阻塞原始响应**；任何劫持异常必须回退到原始 fetch/XHR 行为。B 站 DOM 选择器集中在文件顶部 `SELECTORS` 常量——B 站改版时这是唯一维护点。自己的 DOM 改动必须包在 `withOwnChanges()` 里，避免 observer 反馈环。
- **UI**：三个页面共用同一套设计令牌（`--paper #f4f6f3`、`--ink #26302a`、`--primary #4c7a5c`、`--accent #e0a458`；注意 `--radius` 在 popup 与其他页不同为 12/14px）。全部文案在 `lib/i18n.ts`（`t(key, vars)`）；内容脚本按设计保留少量硬编码字符串。

### 容易踩的坑

- MAIN world 的 `chrome.runtime.sendMessage` 会**静默失败**——必须走桥。
- `startHijack` 必须立即调用一次 `listenFromExtension(() => {})`，否则 `bridgeReady` 永不置位，所有评论消息永久排队（已实测：评论静默丢失而弹幕正常）。
- 桥未就绪时的消息**必须排队补发**（`sendToExtensionWithResponse` 与 `sendToExtension` 一样要排队），否则 `document_start` 阶段的调用会丢消息。
- B 站评论区渲染在 `<bili-comments>` 的 Lit shadow root 内，多层嵌套；评论 DOM 没有 rpid 属性（实测），结果应用按 seq 定位。`queryShadowAll`/`findShadowById` 递归穿透 shadow root；shadow 内全局 CSS 失效，角标必须用 inline style。
- `matches` 数组必须是字面量（WXT 构建期静态分析）——保持薄壳内，不要放进 adapter。

---

## 常见任务

### 添加新 LLM 供应商

1. **`lib/config.ts`**：在 `PROVIDER_PRESETS` 追加一条：
   ```ts
   {
     id: 'newprovider',          // 唯一 id
     label: 'NewProvider',       // 用户可见名称
     hint: '一句话描述',          // 引导页卡片副标题
     baseURL: 'https://api.example.com/v1',
     defaultModel: 'model-name',
   }
   ```
2. **`wxt.config.ts`**：在 `BASE_HOST_PERMISSIONS` 追加该域名的静态 host 权限，如 `'https://api.example.com/*'`。
   - MV3 中 SW 对跨域 `fetch` 必须有 host_permissions。已知提供商走静态声明，避免权限弹窗。
   - 用户自填的**自定义域名**不需要改代码：`optional_host_permissions: ['https://*/*']` + 用户手势内运行时授权已经实现（`lib/config.ts` 的 `originOf`/`hasOriginAccess`/`requestOriginAccess`）。
3. **无需改 UI**：onboarding 引导页与 options 的提供商列表由 `PROVIDER_PRESETS` 驱动。
4. **验证**：`pnpm typecheck` → `pnpm build` → 检查 `.output/chrome-mv3/manifest.json` 出现新域名；在 onboarding/options 里用"测试连接"走通一次。

### 添加新平台（抖音等）

解耦契约：**所有站点差异收敛到 `SiteAdapter`**（`lib/sites/types.ts`）；通用引擎（`hijack-engine.ts`、`rewrite-ui.ts`）、SW、UI 不引用任何具体站点。

1. **新建 `lib/sites/douyin.ts`** 实现 `SiteAdapter`：
   - 必选：`key`、`label`、`matches`、`matchReplyUrl`、`extractReplies`（响应 JSON → `CommentItem[]`，`seq` 由适配器填充）、`resolveCommentRoot`（按 id/seq 定位 DOM）、`commentSelectors`（`root`/`content`/`author`）。
   - 可选：`resolveContentNode`（评论条目内定位文本容器，通用选择器表达不了时提供）。
   - 可选 `danmaku`（`SiteDanmakuAdapter`）：`matchUrl`、`parseResponse`（protobuf/xml/json 自判）、`rebuildResponse`（替换后重编码，null = 无替换）、`applyLiveRewrites?`、`startLiveProbe?`、`onBatchSent?`/`onBatchFailed?`/`onBatchSkipped?`、`onConfigChanged?`。
   - 可选 `videoMeta`：`matchUrl` + `extractDanmakuTotal`（弹幕总量阈值判断用）。
2. **注册**：`lib/sites/registry.ts` 的 `SITE_ADAPTERS` 加一行：
   ```ts
   douyin: douyinAdapter,
   ```
   弹幕适配器用 `douyinAdapter.danmaku = douyinDanmakuAdapter` 挂接（参照 bilibili 的写法）。
3. **新增薄壳内容脚本**：
   - `entrypoints/douyin.content.ts`（isolated、`document_idle`、字面量 `matches`）→ 调 `startRewriteUi(getAdapter('douyin'))`；
   - 有弹幕再加 `entrypoints/douyin-danmaku.content.ts`（`world: 'MAIN'`、`document_start`、matches 含播放器域名）→ 调 `startHijack(getAdapter('douyin'))`。
   - 两个文件名**首段必须不同**；`matches` 保持字面量，开发钩子用 `...(import.meta.env.DEV ? ['http://localhost:8787/*'] : [])` 镜像 bilibili 的写法。
4. **无需改 UI**：onboarding 第 4 步与 options 的站点管理由 `allAdapters()` 自动拾取新站点。
5. **测试钩子**：按 bilibili 的模式在 `wxt.config.ts` 与薄壳中加 `localhost:8788/8787` 的 dev-only 钩子（绝不进生产构建）。
6. **验证**：typecheck → build → 在 fixture 页面（8787）+ 真实站点上验证评论改写、弹幕改写、失败降级三条链路。

> 写适配器时把纯逻辑（URL 匹配、响应解析、protobuf 编解码）保持为可被 Node 直接 import 的纯函数——`lib/sites/` 内的相对导入用 `.ts` 后缀正是为此。

### 新增消息类型

1. 在 **`lib/messages.ts`** 的 `RuntimeMessage` 判别联合中追加（类型名 `KW_*`），并在文件底部同步 `MSG_*` 常量。
2. 按方向接线：CS → SW 在 `background.ts` 的 `onMessage` 里处理；SW → tab 用 `browser.tabs.sendMessage` 广播（弹幕批结果走 `KW_REWRITE_BATCH_RESULT` 聚合，不逐条回发）；MAIN → SW 经桥的消息在 `bridge.ts` 两侧同步加转发分支。
3. 检查 `AGENTS.md` 的消息协议图是否需要同步（保持文档即代码）。

### 修改配置结构

1. `lib/config.ts` 的 `KindlyConfig` 加字段 + `DEFAULT_CONFIG` 补默认值。
2. **必须走迁移链**：在 `MIGRATIONS` 追加 `CURRENT_CONFIG_VERSION: (cfg) => ({ ...cfg, newField: default })`，并自增 `CURRENT_CONFIG_VERSION`。读时迁移在 `getConfig()` 已实现，旧数据缺字段不会崩。
3. 涉及 LLM 请求签名（baseURL/modelName/intensity/includeAuthor/kind）时，缓存自动失效无需处理。

---

## 测试与验证

- **没有测试框架**。项目模式：纯函数（`lib/response-parser.ts`、`lib/prompt.ts`、`lib/errors.ts`、缓存签名逻辑）用 Node 类型剥离直接断言：
  ```bash
  node --input-type=module -e "import { parseRewrites } from './lib/response-parser.ts'; ..."
  ```
- `pnpm typecheck` 是**任何构建/打包前的强制门槛**。
- `pnpm build` 后检查 `.output/chrome-mv3/manifest.json` 的权限/matches 是否有漂移；**断言 `localhost` 永不出现**在生产 manifest。
- 浏览器级流程（引导向导、popup 状态、B 站真实页面改写）需人工验证——内容脚本的 B 站选择器是最脆弱的部分，B 站改版后必须真页验证。

---

## 提交 PR 前检查清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build` 通过，生产 manifest 无 `localhost`、权限无漂移
- [ ] 新消息/新配置/新站点已同步 `AGENTS.md` 或本文件
- [ ] 错误路径全部降级为显示原文，无跨消息抛异常
- [ ] 纯逻辑（解析、编解码、URL 匹配）可被 Node 独立测试
- [ ] 无遗留 console.log / 调试代码 / 未用的导入（strict 会抓后者）
- [ ] 涉及内容脚本的改动已在真实 B 站页面（或 fixture 页）验证
- [ ] 开发者模式下 `localhost:8788` mock 的故障注入（auth/429/timeout/500/parse）各走一遍
