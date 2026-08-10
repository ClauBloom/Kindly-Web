# Repository Guidelines

## Project Overview

**Kindly Web** — a Chrome extension (Manifest V3) that rewrites hostile comments on Bilibili into kind, rational expressions via a user-configured LLM API. Built with **WXT 0.21 + vanilla TypeScript** (no UI framework). Architecture and design decisions are documented in this file (see Architecture & Data Flow below).

Security invariant: **LLM requests happen ONLY in the Service Worker** (`entrypoints/background.ts`). The API key never enters page processes; content scripts only receive rewritten text DTOs.

## Architecture & Data Flow

**采集 = 劫持 B 站前端 API**（main-world 内容脚本包装页面 fetch/XHR）：

```
Bilibili page / player iframe ──> bilibili-danmaku.content.ts (world: MAIN, document_start)
   wrap window.fetch + XHR by URL:
   ├─ /x/v2/reply/(main|reply)  → 响应零阻塞放行（页面先渲染原文）→ 提取 rpid/message
   │                               → KW_REWRITE_COMMENTS → SW 改写 → 结果回传
   │                               → bilibili.content.ts (ISOLATED) 按 rpid 定位 DOM 替换
   └─ /x/v2/dm/web/seg.so (protobuf) /x/v1/dm/list.so (xml)  → 先放行（不阻塞播放器）
                                     → 全量分批并发（40/批 × 4 在飞）→ KW_REWRITE_BATCH → SW 批量改写
                                     → 完成后：① 屏上替换（DOM 元素文本匹配，状态角标 改/✓/!/跳）
                                       ② 结果缓存，播放器重载段时直接替换响应
popup / onboarding / options ──KW_SET_ENABLED / KW_CONFIG_CHANGED / KW_TEST_CONNECTION / KW_GET_STATUS──> SW
```

- **两个内容脚本，两个 world**：`bilibili-danmaku.content.ts`（`world: 'MAIN'`，劫持层，matches 含 `player.bilibili.com`；`runAt: document_start` 必须在页面业务脚本前完成包装）；`bilibili.content.ts`（`world: 'ISOLATED'`，结果应用层：DOM 替换/气泡/角标）。WXT entrypoint 名冲突规则：两者必须用不同文件名首段（`bilibili.content.ts` vs `bilibili-danmaku.content.ts`）。
- **MAIN world 无 chrome.runtime（已实测，Chrome 137+ Self-XSS 防护）**：main-world 劫持层**不能**直接 `chrome.runtime.sendMessage`（静默失败）。所有 main world ↔ 扩展通信走 `lib/bridge.ts` 的 postMessage 桥：isolated 侧 `startBridge()` 转发（含 ready 握手 + 未就绪消息队列，覆盖页面脚本先于 CS 注入的竞态）；弹幕批结果经桥回传 MAIN。**`startHijack` 必须立即调用一次 `listenFromExtension(() => {})`**——否则 bridgeReady 永不置位，所有评论消息永远排队（已实测：评论静默丢失而弹幕正常）。
- **B 站接口为 wbi 路径（实测 2026-08）**：评论 `/x/v2/reply/wbi/main`、弹幕 `/x/v2/dm/wbi/web/seg.so`。URL 正则必须匹配 `(?:wbi/)?` 段。
- **B 站评论区渲染在 `<bili-comments>` 的 Lit shadow root 内**：多层嵌套（`bili-comments` → `#feed > bili-comment-thread-renderer` → `bili-comment-renderer#comment` → `#content > bili-rich-text` → `#contents`），**评论 DOM 没有 rpid 属性**（实测）→ 结果应用按 **seq**（接口顺序 ↔ `#feed` 直接子 thread 顺序）定位；**置顶评论（`data.top_replies`）渲染在评论区最前**，提取必须纳入并先于 replies 编序（2026-08 实测，遗漏会导致全列表 seq 错位）；**楼中楼**（`/x/v2/reply/reply` 与 main 接口内嵌 `replies[].replies`）按 **path**（`[顶层 thread seq, 楼中楼内索引]`）定位——thread shadow → `div#replies > bili-comment-replies-renderer` (shadow) → `div#expander > div#expander-contents` → `bili-comment-reply-renderer`（亦有 shadow，内部 `div#body > bili-rich-text > #contents`）；main 劫持时建立 rpid→thread seq 映射供 reply 接口定位父线程；**文本匹配必须规范化**（`normalizeCommentText`，`lib/sites/bilibili.ts`：去 `[表情]` 标记 + 压缩空白——DOM 渲染后表情变图片、textContent 缺标记，接口原文与 DOM 文本不一致）；seq 命中后校验文本，不符则按规范化原文在全部线程/楼中楼列表中兜底匹配（优先未登记结果），找不到返回 null 不误替换；"查看全部回复"替换列表导致索引偏移同理。第二层（回复的回复）不提取不改写。rewrite-ui 的 `queryShadowAll`/`findShadowById` 递归穿透 shadow root；fallback observer 递归 observe shadow roots；badge 用 inline style（shadow 内全局 CSS 失效）。结果先于 DOM 渲染的竞态在 shadow 场景同样存在（pendingResults 队列，存 seq/path，15s 窗口）。
- **评论异步语义**：劫持响应**原样放行**（用户立即看到原文）→ 异步改写 → 结果按 **seq**（顶层：接口 replies 顺序 ↔ `#feed` 内 thread 顺序）或 **path**（楼中楼：`[顶层 seq, 子索引]`）定位 DOM 替换（`rpid`/`data-kw-id` 属性为回退路径，含 shadow 穿透）。**表情重建**（实测 2026-08）：B 站把 `[doge]` 等渲染为 `<img alt="[doge]" src="//i0.hdslb.com/bfs/emote/…">`（alt 即标记），替换/恢复/占位统一走 `rebuildTextWithEmotes`（rewrite-ui.ts，collectEmotes 收集原文表情元素、按标记克隆复用），改写文本中的表情标记保持图片显示而非字面文本。**结果可能先于 DOM 渲染到达**（快速模型/本地 mock，已实测触发）→ `pendingResults`/`pendingErrors` 队列重试 15s。若 10s 内未收到 `KW_HIJACK_ACTIVE`（劫持失效，如 B 站改版），isolated CS 回退 MutationObserver 采集（兜底路径仅覆盖顶层评论）。
- **弹幕异步语义**：先放行（弹幕立即显示，绝不等待）→ **弹幕全量送 SW 改写**（阴阳怪气交由 LLM 判断，LLM 侧有"本身友善则原样返回"规则兜底）→ 改写结果**屏上替换**。**全量批管道**（lib/hijack-engine.ts）：段内弹幕按 `DM_BATCH_SIZE=10` 条/批切片（小批 → LLM 响应快），`DM_MAX_INFLIGHT=16` 批并发在飞，SW 全局并发 `MAX_CONCURRENCY=64`、最小请求间隔 50ms、批超时 `BATCH_TIMEOUT_MS=45s`；不设单段条数上限，弹幕密集视频全量分批处理（成本 ≈ 段内条数/批大小 次 LLM 请求）。**弹幕处理上限**（`config.danmakuMaxTotal`，options 下拉 100~10万/无上限，默认 1万）：main-world 劫持 `/x/web-interface/(wbi/)?view`（view 或 view/detail，注意 `data.View.stat.danmaku` 嵌套结构）提取视频弹幕总量 → `KW_VIDEO_META` 上报 SW（per-tab）→ `KW_REWRITE_BATCH` 到达时总量超阈值整批放行原文（`skipped: true` 标记，弹幕打"跳"角标；弹幕量极大的视频通常引战少，跳过省成本）。**SSR 兜底数据源**（实测 2026-08）：B 站新版视频页不再请求 view 接口（信息内嵌 `window.__INITIAL_STATE__.videoData.stat.danmaku`），`startHijack` 时轮询读取（300ms 起 100ms 间隔、5s 超时）经 `KW_VIDEO_META` 上报，与 fetch 劫持路径双路并用以防阈值失效。
- **隐藏原文模式**（`config.hideOriginalComment`/`hideOriginalDanmaku`，options 两个 checkbox，默认关）：开启后评论/弹幕加载即显示"重写中"占位（原文不外露），改写完成后替换为友善版；失败恢复原文 + 错误角标。评论链路：main-world 发送后经 `KW_COMMENTS_PENDING`（SW 定向转发 tab）广播 id 到 isolated，`pendingCommentIds` 集合驱动占位（元素已渲染 → 立即占位；渲染晚于发送 → collectEntry 时占位；observer 兜底路径在 flushBatch 内直接占位）；弹幕链路：`onBatchSent` 时 `pendingTexts` 标记，`applyDmTextReplacements` 统一占位（dataset.kwDmOrig 记录原文，结果/失败恢复）。**弹幕"过中线恢复"**（2026-08 新增）：隐藏模式 + 处理中的占位弹幕划过播放器中线（右边缘越过中线，`dmCrossedMidline` 纯函数判定）仍未改写 → 自动恢复原文并退出处理中（250ms 轮询，仅存在占位元素时活跃、无占位自停；结果若在屏期间返回仍正常替换）。MAIN 侧配置经 `KW_GET_CONFIG`/`KW_CONFIG` 桥同步（`syncMainConfig`，桥就绪前排队——**sendToExtensionWithResponse 必须与 sendToExtension 一样排队补发**，否则 document_start 调用丢消息）。**B 站新版弹幕是 DOM 元素渲染（实测 2026-08）**：`.bpx-player-render-dm-wrap` 下 `.bili-danmaku-x-dm` 无 id 属性 → `lib/sites/bilibili-danmaku.ts` 的 DOM 观察器按**规范化文本**匹配替换 textContent（所有弹幕状态 Map 的 key 统一为 `normalizeCommentText` 结果——弹幕含 `[表情]` 时 DOM 文本缺标记，2026-08 实测大量弹幕因此匹配失败；旧版 canvas 播放器的内存列表探测保留为回退——新版列表在 webpack 闭包不可达，实测失效）。弹幕批结果经 `KW_REWRITE_BATCH`/`KW_REWRITE_BATCH_RESULT` 聚合回发（12s 超时兜底放行原文）。**弹幕处理状态角标**（屏上可见，随弹幕元素生命周期自然清理）：已送 LLM 未回 = 灰"改"（15s 无结果自动降级不显示）、改写成功 = 绿"✓"、失败 = 红"!"（悬停见原因）；状态由 adapter 钩子 `onBatchSent`/`onBatchFailed` 维护（`pendingTexts`/`failTexts`），`applyLiveRewrites` 成功时清除。
- **Message protocol**: all `KW_*` message types defined as a discriminated union in `lib/messages.ts`. DOM nodes never cross messages — the content script keeps a `Map<id, HTMLElement>` registry + `data-kw-id` attribute; messages carry only the id.
- **Storage layering**: `chrome.storage.sync` key `config` (non-sensitive prefs, `KindlyConfig` incl. `version` for read-time migration) vs `chrome.storage.local` keys `apiKey` (sensitive, multi-key comma-separated), `kwCache` (sha256 cache), `kwQueueMirror` (SW queue persistence for wake-up recovery).
- **Queue scheduler** (SW): per-tabId FIFO queues, global concurrency ≤ 64, min 50ms between request starts, batches of `config.batchSize`, 429 exponential backoff (respects `Retry-After`, cap 60s, 3 consecutive → drop batch + pause 60s), network/parse retry ≤ `config.retryCount` (0–5, 默认 2; network 退避 = `retryIntervalSec`×2ⁿ 默认 1s/2s, parse 立即重试), 30s `AbortController` timeout, 401/403 → stop all queues (cleared by config save/test connection), failure-rate circuit breaker (20-window, 60% → pause with auto-resume), multi-key round-robin. Danmaku batch items (`requestId` set) aggregate in SW and get one `KW_REWRITE_BATCH_RESULT` instead of per-item messages; failures fall back to original text.
- **Cache**: `sha256(original + "\n" + sig)` where `sig = baseURL|modelName|intensity|includeAuthor|kind`（输出风格 `styleId`/`customStyles` 解析出的指令非空时再追加 `|style` 段，默认"仅改写"不追加、与旧缓存兼容）— config changes auto-invalidate; comment vs danmaku prompts use different kinds. LRU ~2000 entries in `storage.local`.
- **输出风格（提示词预设）**: `config.styleId` + `config.customStyles`（v2 配置）。内置 6 个预置（默认/2010B站/2016B站/2019B站/2019抖音/猫娘）定义在 `STYLE_PRESETS`（lib/config.ts），风格指令为空串时不注入 system prompt（默认行为与旧版一致）；非空时作为第 6 条规则追加。**统一改写语义**（2026-08）：风格化时 prompt 的"原样返回"规则切换为"所有条目都必须改写"（友善内容也套用风格），保证风格统一生效；默认风格保留"友善内容原样返回"。`resolveStyleInstruction`（lib/prompt.ts）为唯一解析入口，SW 取签名与拼 prompt 共用，保证同源。缓存签名中非默认风格段带 prompt 版本前缀 `p2`（规则变化自动失效旧缓存；默认风格不加段兼容旧缓存）。自定义风格在 options 页增删，删除当前选中项回退默认。
- **Error taxonomy**: `RewriteReason = auth | rate_limited | timeout | network | parse | empty`. SW classifies, CS degrades (badge + retry popover with provider error detail), UI renders via `REASON_LABELS` / i18n keys.

## Key Directories

| Path | Purpose |
|---|---|
| `entrypoints/` | WXT entrypoints (build-driven conventions, see below) |
| `entrypoints/background.ts` | Service Worker: queue, retries, cache, test connection |
| `entrypoints/bilibili.content.ts` | Bilibili comment collector/replacer (single content script) |
| `entrypoints/popup/`, `onboarding/`, `options/` | UI pages, each `index.html` + `main.ts` + `style.css` |
| `lib/` | Shared, browser-agnostic modules (import via `@/lib/...`) |
| `lib/hijack-engine.ts` | Generic main-world API hijack engine (fetch/XHR wrapping, comment pass-through, danmaku pipeline) — site-agnostic |
| `lib/rewrite-ui.ts` | Generic isolated-world result applier (registry, replace/bubble/badge, observer fallback) — site-agnostic |
| `lib/sites/` | **Site adapters** (decoupling core): `types.ts` (SiteAdapter contract), `registry.ts` (SITE_ADAPTERS), `bilibili.ts` (comment URL/extract/DOM), `bilibili-danmaku.ts` (protobuf codec, DOM on-screen replace + probe fallback) |
| `lib/bilibili.css` | Injected styles for the content script (`kw-` prefixed) |
| `.output/` | Build output (gitignored) |

## Development Commands

Requires **Node ≥ 22 + pnpm**. Do not use npm/yarn.

```bash
pnpm install     # postinstall runs `wxt prepare` (generates .wxt/ types)
pnpm dev         # dev server + HMR (Chrome launches with the extension)
pnpm build       # production build → .output/chrome-mv3/
pnpm zip         # build + zip → .output/kindly-web-<version>-chrome.zip
pnpm typecheck   # tsc --noEmit (strict) — primary gate
```

Load the unpacked build from `.output/chrome-mv3` in `chrome://extensions` (dev mode). Dev builds go to `.output/chrome-mv3-dev` with localhost test hooks (see Runtime/Tooling).

## Code Conventions & Common Patterns

- **TypeScript strict**: `strict + noUnusedLocals + noUnusedParameters`; `import type` for type-only imports; narrow `unknown` before use; `noUncheckedIndexedAccess` is on — guard array/Map indexing (e.g. `if (!entry) return;`).
- **WXT entrypoint conventions** (0.21): `background.ts` → SW; content scripts must be named `*.content.ts` (do not use a `content-scripts/` directory); pages are directories with `index.html`. `matches`/`runAt` are declared inside `defineContentScript`; content script CSS is imported from the TS file and extracted to the manifest.
- **Imports**: `browser` from `wxt/browser` (chrome at runtime); shared code via `@/lib/...` alias.
- **Async**: fire-and-forget with `void` prefix (`void notifyTab(...)`); `onMessage` listeners return `false` for sync handling, `true` + `sendResponse` for async; catch `Extension context invalidated` errors in content scripts and self-clean (`restoreAll()`).
- **Errors**: never throw across the message boundary — classify into `RewriteReason`, attach optional `detail` (provider error text, truncated to 200 chars, never containing the key). Any failure must degrade to showing the original text.
- **Naming**: message types `KW_*` (single source: `lib/messages.ts` — add new messages there first); storage keys `kw*`; injected CSS classes `kw-*`; JSDoc in Chinese.
- **Content script patterns** (important): the hijack script wraps `window.fetch`/`XMLHttpRequest` in the MAIN world at `document_start` and must never block the original response (comments: zero-blocking pass-through + async rewrite; danmaku: pass-through + async rewrite + in-flight replacement). Any hijack exception must fall back to the original fetch/XHR behavior. The isolated script's DOM selectors for Bilibili live in the `SELECTORS` const at the top — the single maintenance point when Bilibili changes their DOM. Own DOM mutations must be wrapped in `withOwnChanges()` to avoid observer feedback loops.
- **UI**: three pages duplicate the same CSS design tokens (`--paper #f4f6f3`, `--ink #26302a`, `--primary #4c7a5c`, `--accent #e0a458` — note `--radius` differs 12/14px between popup and the others). All copy lives in `lib/i18n.ts` (`t(key, vars)`); the content script has a few hardcoded strings by design.
- **New provider**: add an entry to `PROVIDER_PRESETS` in `lib/config.ts` AND to `BASE_HOST_PERMISSIONS` in `wxt.config.ts` (static host permissions); custom domains rely on `optional_host_permissions` + runtime `permissions.request` inside a user gesture.
- **Git**: repository owner keeps git hands-off — do not commit, stage, or run git commands.

## Important Files

| File | Why it matters |
|---|---|
| `wxt.config.ts` | Manifest: `permissions: ["storage"]` only, 4 static API host permissions, `optional_host_permissions: ["https://*/*"]`, no `content_security_policy` field (deliberate — CSP can't cover user-added domains) |
| `entrypoints/background.ts` | The only place that reads the API key and calls `fetch` |
| `entrypoints/bilibili-danmaku.content.ts` | Main-world API hijack: fetch/XHR wrapping, reply extraction, danmaku pipeline (world: MAIN) |
| `entrypoints/bilibili.content.ts` | Isolated-world result applier: rpid-driven DOM replacement, hover/error UI, observer fallback |
| `lib/danmaku-pb.ts` | Minimal protobuf codec for seg.so (field-order-preserving re-encode) |
| `lib/sites/bilibili-danmaku.ts` | Bilibili danmaku adapter: protobuf codec, response rebuild, DOM on-screen replacement (text-match observer) |
| `lib/config.ts` | `KindlyConfig` schema + defaults, provider presets, version migration chain (`MIGRATIONS`), multi-key parsing, permission helpers |
| `lib/messages.ts` | The complete message protocol — check before touching any messaging code |
| `lib/response-parser.ts` | Pure-function LLM output parser (tolerant JSON extraction, array/wrapped/line-protocol forms, field aliases) — keep it framework-free |

## Adding a New Platform (Douyin, etc.)

The decoupling contract: **all site differences live in a `SiteAdapter`** (`lib/sites/types.ts`); the generic engines (`lib/hijack-engine.ts`, `lib/rewrite-ui.ts`), Service Worker, and UI never reference concrete sites.

1. Create `lib/sites/douyin.ts` implementing `SiteAdapter` (comment URL match, `extractReplies`, `resolveCommentRoot`, `commentSelectors`; optional `danmaku` — URL match, `parseResponse(Uint8Array)`, `rebuildResponse`, live-probe hooks).
2. Register it in `lib/sites/registry.ts` (`SITE_ADAPTERS`).
3. Add thin content-script shells: `entrypoints/douyin.content.ts` (isolated, `document_idle`, literal `matches`) and, if danmaku, `entrypoints/douyin-danmaku.content.ts` (world: MAIN, `document_start`, literal `matches` incl. player domain). Shells just call `startRewriteUi(getAdapter('douyin'))` / `startHijack(getAdapter('douyin'))`. Names must differ in their first segment.
4. UI (onboarding step 4, options site management) picks the new site up automatically from `allAdapters()`.
5. Add dev test hooks for the new domain in `wxt.config.ts` and the shells, mirroring `localhost:8787/8788`.

**WXT entrypoint caveat**: `matches` arrays must stay literal (build-time static analysis) — keep them in the shell, not the adapter. Relative imports inside `lib/sites/` use explicit `.ts` extensions so pure logic stays node-testable.

## Runtime/Tooling Preferences

- **Runtime**: Node ≥ 22 (WXT engine requirement), pnpm only, no `packageManager` field declared.
- **Chrome for Testing**: brand-name Chrome 137+ ignores `--load-extension` — use Chrome for Testing or the user's own browser to test the extension.
- **Dev-only test hooks**: in `development` mode the manifest adds `http://localhost:8788/*` (mock LLM) to host permissions and `http://localhost:8787/*` to content-script matches (fixture page with Bilibili-like DOM). Both servers live in `/tmp/kw-test/` (mock OpenAI-compatible API with `?fail=auth|429|timeout|500|parse` fault injection). Never leak these into production builds.
- **CSP**: keep the default MV3 CSP — do not add `content_security_policy` (`host_permissions` is the network gate).

## Testing & QA

- **No test framework installed.** The project's testing pattern is: pure functions (`lib/response-parser.ts`, `lib/prompt.ts`, `lib/errors.ts`, cache sig logic) are exercised with Node type-stripping assertions:
  ```bash
  node --input-type=module -e "import { parseRewrites } from './lib/response-parser.ts'; ..."
  ```
- `pnpm typecheck` is the mandatory gate before any build/zip.
- `pnpm build` + inspect `.output/chrome-mv3/manifest.json` for permission/match drift; assert `localhost` never appears in production manifests.
- Browser-level flows (onboarding wizard, popup states, live rewrite on Bilibili) are verified manually by the user — the content script's Bilibili selectors are the most fragile surface and need real-page validation after Bilibili DOM changes.
