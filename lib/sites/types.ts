/**
 * 站点适配器契约（解耦核心）。
 *
 * 目标：Kindly Web 可接入任意"评论区/弹幕"平台（B 站已实现，抖音等未来接入）。
 * 站点差异被收敛为 SiteAdapter 一个接口：
 *  - 评论：URL 匹配 + 响应提取 + DOM 定位 + 采集选择器（isolated world）
 *  - 弹幕（可选能力）：URL 匹配 + 响应解析 + 重编码 + 屏上替换
 * 通用引擎（lib/hijack-engine.ts、lib/rewrite-ui.ts）只依赖本接口，
 * 不感知任何具体站点。SW 与 UI 通过 lib/sites/registry.ts 读取站点列表。
 */

import type { CommentItem } from '@/lib/messages';

export interface SiteDanmakuAdapter {
  /** 弹幕接口 URL 匹配（main world，劫持层） */
  matchUrl(url: string): boolean;
  /** 解析弹幕响应字节（protobuf / xml / json 由适配器自判）→ 弹幕列表 */
  parseResponse(data: Uint8Array): { id: string; text: string }[];
  /**
   * 重编码响应：将命中 id 的弹幕文本替换后返回新字节。
   * 返回 null 表示响应中无可替换内容（调用方应原样放行）。
   */
  rebuildResponse(buf: Uint8Array, replacements: ReadonlyMap<string, string>): Uint8Array | null;
  /**
   * 屏上替换：改写结果应用到已渲染弹幕（DOM 元素按原文文本匹配替换为主，
   * 播放器内存列表为回退）。返回 false = 未能定位（降级为缓存重载替换）。
   */
  applyLiveRewrites?(replacements: ReadonlyMap<string, string>): boolean;
  /** 启动屏上替换探测（播放器初始化可能需要时间，内部自定重试策略） */
  startLiveProbe?(): void;
  /** 弹幕批已发送改写（屏上标记"处理中"；items 含 id/text） */
  onBatchSent?(items: { id: string; text: string }[]): void;
  /** 弹幕批中部分/全部改写失败（保持原文；屏上标记"失败"） */
  onBatchFailed?(ids: string[], reason?: string): void;
  /** 弹幕被跳过改写（视频弹幕总量超过处理上限；保持原文，屏上标记"跳过"） */
  onBatchSkipped?(ids: string[], reason: string): void;
  /**
   * 配置变化（MAIN 侧 config 同步后回调；hideOriginal 传入最新值）。
   * 适配器借此重新同步屏上占位状态（隐藏原文开启时把已加载原文替换为"重写中"）。
   */
  onConfigChanged?(hideOriginalDanmaku: boolean): void;
}

export interface SiteCommentSelectors {
  /** 评论条目容器选择器（observer 兜底采集用） */
  root: string;
  /** 评论文本容器选择器 */
  content: string;
  /** 评论者昵称选择器 */
  author: string;
}

export interface SiteVideoMeta {
  /** 视频信息接口 URL 匹配（如 B 站 /x/web-interface/view；main world 劫持层） */
  matchUrl(url: string): boolean;
  /** 从响应提取弹幕总量（stat.danmaku 等）；拿不到返回 null */
  extractDanmakuTotal(data: unknown): number | null;
  /**
   * 从页面内嵌数据提取弹幕总量（B 站新版页面不再请求 view 接口，实测 2026-08：
   * 视频信息内嵌于 window.__INITIAL_STATE__.videoData.stat.danmaku）。
   * main world 轮询读取（document_start 时页面脚本尚未执行）；返回 null = 暂不可用。
   */
  extractDanmakuTotalFromPage?(): number | null;
}

export interface SiteAdapter {
  /** 站点键（= enabledSites 配置值），如 'bilibili' */
  key: string;
  /** 用户可见名称，如 'Bilibili 评论区' */
  label: string;
  /** 弹幕能力用户可见名称（站点管理中弹幕开关行；缺省用 `${label} 弹幕`） */
  danmakuLabel?: string;
  /** 站点域名匹配（manifest content_scripts.matches；entrypoint 内仍需字面量） */
  matches: string[];
  /** 评论 API URL 匹配（main world，劫持层） */
  matchReplyUrl(url: string): boolean;
  /** 评论响应提取（响应 JSON → CommentItem[]，零阻塞路径；seq/path 由适配器填充） */
  extractReplies(data: unknown, url: string): CommentItem[];
  /**
   * 按 id（rpid 等）定位评论 DOM 节点（isolated world，结果应用）。
   * seq = 接口响应索引（B 站评论区 DOM 无 rpid 属性，只能按顺序定位）；
   * path = 渲染树路径（path[0] = #feed 顶层索引，后续为楼中楼逐层子索引），
   * 楼中楼回复必须提供 path；original 供文本匹配兜底（列表顺序变化时防错位）。
   */
  resolveCommentRoot(id: string, seq?: number, path?: number[], original?: string): HTMLElement | null;
  /**
   * 定位评论条目的文本容器（B 站评论文本在多层嵌套 shadow 的 bili-rich-text 内，
   * 通用选择器无法表达 → 适配器提供；返回 null 时回退 commentSelectors.content）
   */
  resolveContentNode?(root: HTMLElement): HTMLElement | null;
  /** 定位评论者昵称节点（顶层/楼中楼结构不同且均在 shadow 内；缺失时回退 commentSelectors.author） */
  resolveAuthorNode?(root: HTMLElement): HTMLElement | null;
  /**
   * 评论文本规范化（去掉平台表情标记、压缩空白）：DOM 渲染后表情变图片，
   * textContent 与接口原文不一致，文本匹配必须经规范化比较。
   */
  normalizeText?(text: string): string;
  /** 评论 DOM 选择器（isolated world，结果应用与兜底采集） */
  commentSelectors: SiteCommentSelectors;
  /** 弹幕能力（站点无弹幕则不提供） */
  danmaku?: SiteDanmakuAdapter;
  /** 视频信息能力（弹幕阈值判断需要弹幕总量；站点无则跳过） */
  videoMeta?: SiteVideoMeta;
}
