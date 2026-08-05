# Repository Guidelines

## Project Overview

**Kindly Web** — a Chrome extension (Manifest V3) that rewrites hostile comments on Bilibili into kind, rational expressions via a user-configured LLM API. Built with **WXT 0.21 + vanilla TypeScript** (no UI framework). Architecture and design decisions live in `docs/ARCHITECTURE.md` (Chinese) — code comments reference it by section number (`docs/ARCHITECTURE.md §4.2`).

Security invariant: **LLM requests happen ONLY in the Service Worker** (`entrypoints/background.ts`). The API key never enters page processes; content scripts only receive rewritten text DTOs.

## Architecture & Data Flow

**采集改为「劫持 B 站前端 API」**（main-world 内容脚本包装页面 fetch/XHR），不再依赖 DOM 扫描：

```
Bilibili page / player iframe ──> bilibili-danmaku.content.ts (world: MAIN, document_start)
   wrap window.fetch + XHR by URL:
   ├─ /x/v2/reply/(main|reply)  → 响应零阻塞放行（页面先渲染原文）→ 提取 rpid/message
   │                               → KW_REWRITE_COMMENTS → SW 改写 → 结果回传
   │                               → bilibili.content.ts (ISOLATED) 按 rpid 定位 DOM 替换
   └─ /x/v2/dm/web/seg.so (protobuf) /x/v1/dm/list.so (xml)  → 先放行（不阻塞播放器）
                                     → 本地过滤器筛可疑弹幕 → KW_REWRITE_BATCH → SW 批量改写
                                     → 完成后：① 屏上替换（探测播放器内存弹幕列表，改 content，
                                       canvas 下一帧重绘）② 结果缓存，播放器重载段时直接替换响应
popup / onboarding / options ──KW_SET_ENABLED / KW_CONFIG_CHANGED / KW_TEST_CONNECTION / KW_GET_STATUS──> SW
```

- **两个内容脚本，两个 world**：`bilibili-danmaku.content.ts`（`world: 'MAIN'`，劫持层，matches 含 `player.bilibili.com`；`runAt: document_start` 必须在页面业务脚本前完成包装）；`bilibili.content.ts`（`world: 'ISOLATED'`，结果应用层：DOM 替换/气泡/角标）。WXT entrypoint 名冲突规则：两者必须用不同文件名首段（`bilibili.content.ts` vs `bilibili-danmaku.content.ts`）。
- **MAIN world 无 chrome.runtime（已实测，Chrome 137+ Self-XSS 防护）**：main-world 劫持层**不能**直接 `chrome.runtime.sendMessage`（静默失败）。所有 main world ↔ 扩展通信走 `lib/bridge.ts` 的 postMessage 桥：isolated 侧 `startBridge()` 转发（含 ready 握手 + 未就绪消息队列，覆盖页面脚本先于 CS 注入的竞态）；弹幕批结果经桥回传 MAIN。**`startHijack` 必须立即调用一次 `listenFromExtension(() => {})`**——否则 bridgeReady 永不置位，所有评论消息永远排队（已实测：评论静默丢失而弹幕正常）。
- **B 站接口已切换 wbi 路径（实测 2026-08）**：评论 `/x/v2/reply/wbi/main`（非 `/x/v2/reply/main`，后者仍可用但页面不再请求）、弹幕 `/x/v2/dm/wbi/web/seg.so`。URL 正则必须匹配 `(?:wbi/)?` 段。
- **B 站新版评论区渲染在 `<bili-comments>` 的 Lit shadow root 内**：多层嵌套（`bili-comments` → `#feed > bili-comment-thread-renderer` → `bili-comment-renderer#comment` → `#content > bili-rich-text` → `#contents`），**评论 DOM 没有 rpid 属性**（实测）→ 结果应用按 **seq**（接口 replies 索引 ↔ `#feed` 直接子 thread 顺序）定位；楼中楼（`/x/v2/reply/reply`）不提取不改写。rewrite-ui 的 `queryShadowAll`/`findShadowById` 递归穿透 shadow；fallback observer 递归 observe shadow roots；badge 用 inline style（shadow 内全局 CSS 失效）。结果先于 DOM 渲染的竞态在 shadow 场景同样存在（pendingResults 队列，存 seq）。
- **评论异步语义**：劫持响应**原样放行**（用户立即看到原文）→ 异步改写 → 结果按 `rpid` 定位 DOM 替换（`[rpid="..."]` 或 `data-kw-id`，含 shadow 穿透）。**结果可能先于 DOM 渲染到达**（快速模型/本地 mock，已实测触发）→ `pendingResults`/`pendingErrors` 队列重试 6s。若 10s 内未收到 `KW_HIJACK_ACTIVE`（劫持失效，如 B 站改版），isolated CS 回退 MutationObserver 采集。
- **弹幕异步语义**：先放行（弹幕立即显示，绝不等待）→ 本地过滤器（`lib/badwords.ts`，命中率低）筛出可疑弹幕送 SW → 改写结果**屏上替换**（播放器弹幕引擎每帧从内存列表重绘 canvas，改 `content` 字段下一帧生效；探测失败则降级为缓存重载替换，弹幕维持原文）。弹幕批结果经 `KW_REWRITE_BATCH`/`KW_REWRITE_BATCH_RESULT` 聚合回发（12s 超时兜底放行原文）。
- **Message protocol**: 13 `KW_*` message types defined as a discriminated union in `lib/messages.ts`. DOM nodes never cross messages — the content script keeps a `Map<id, HTMLElement>` registry + `data-kw-id` attribute; messages carry only the id.
- **Storage layering**: `chrome.storage.sync` key `config` (non-sensitive prefs, `KindlyConfig` incl. `version` for read-time migration) vs `chrome.storage.local` keys `apiKey` (sensitive, multi-key comma-separated), `kwCache` (sha256 cache), `kwQueueMirror` (SW queue persistence for wake-up recovery).
- **Queue scheduler** (SW): per-tabId FIFO queues, global concurrency ≤ 5, min 250ms between request starts, batches of `config.batchSize`, 429 exponential backoff (respects `Retry-After`, cap 60s, 3 consecutive → drop batch + pause 60s), network retry ≤ 2 (1s/2s), 30s `AbortController` timeout, 401/403 → stop all queues, failure-rate circuit breaker (20-window, 60% → pause), multi-key round-robin. Danmaku batch items (`requestId` set) aggregate in SW and get one `KW_REWRITE_BATCH_RESULT` instead of per-item messages; failures fall back to original text.
- **Cache**: `sha256(original + "\n" + sig)` where `sig = baseURL|modelName|intensity|includeAuthor|kind` — config changes auto-invalidate; comment vs danmaku prompts use different kinds. LRU ~2000 entries in `storage.local`.
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
| `lib/sites/` | **Site adapters** (decoupling core): `types.ts` (SiteAdapter contract), `registry.ts` (SITE_ADAPTERS), `bilibili.ts` (comment URL/extract/DOM), `bilibili-danmaku.ts` (protobuf codec, probe) |
| `lib/bilibili.css` | Injected styles for the content script (`kw-` prefixed) |
| `docs/ARCHITECTURE.md` | Design authority; keep in sync when behavior changes |
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
- **WXT entrypoint conventions** (0.21): `background.ts` → SW; content scripts must be named `*.content.ts` (the old `content-scripts/` directory convention from `docs/ARCHITECTURE.md` is **stale** — do not create it); pages are directories with `index.html`. `matches`/`runAt` are declared inside `defineContentScript`; content script CSS is imported from the TS file and extracted to the manifest.
- **Imports**: `browser` from `wxt/browser` (chrome at runtime); shared code via `@/lib/...` alias.
- **Async**: fire-and-forget with `void` prefix (`void notifyTab(...)`); `onMessage` listeners return `false` for sync handling, `true` + `sendResponse` for async; catch `Extension context invalidated` errors in content scripts and self-clean (`restoreAll()`).
- **Errors**: never throw across the message boundary — classify into `RewriteReason`, attach optional `detail` (provider error text, truncated to 200 chars, never containing the key). Any failure must degrade to showing the original text.
- **Naming**: message types `KW_*` (single source: `lib/messages.ts` — add new messages there first); storage keys `kw*`; injected CSS classes `kw-*`; JSDoc in Chinese referencing `docs/ARCHITECTURE.md §N`.
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
| `lib/badwords.ts` | Local danmaku aggressiveness filter (recall-oriented, LLM is the judge) |
| `lib/danmaku-inject.ts` | Progressive-enhancement probe into player's in-memory danmaku list |
| `lib/config.ts` | `KindlyConfig` schema + defaults, provider presets, version migration chain (`MIGRATIONS`), multi-key parsing, permission helpers |
| `lib/messages.ts` | The complete message protocol — check before touching any messaging code |
| `lib/response-parser.ts` | Pure-function LLM output parser (tolerant JSON extraction, array/wrapped/line-protocol forms, field aliases) — keep it framework-free |
| `docs/ARCHITECTURE.md` | Design decisions, security rationale, error table, prompt/intensity semantics |

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
- **CSP**: keep the default MV3 CSP — do not add `content_security_policy` (option A in ARCHITECTURE.md: `host_permissions` is the network gate).

## Testing & QA

- **No test framework installed.** The project's testing pattern is: pure functions (`lib/response-parser.ts`, `lib/prompt.ts`, `lib/errors.ts`, cache sig logic) are exercised with Node type-stripping assertions:
  ```bash
  node --input-type=module -e "import { parseRewrites } from './lib/response-parser.ts'; ..."
  ```
- `pnpm typecheck` is the mandatory gate before any build/zip.
- `pnpm build` + inspect `.output/chrome-mv3/manifest.json` for permission/match drift; assert `localhost` never appears in production manifests.
- Browser-level flows (onboarding wizard, popup states, live rewrite on Bilibili) are verified manually by the user — the content script's Bilibili selectors are the most fragile surface and need real-page validation after Bilibili DOM changes.
