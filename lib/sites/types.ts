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
   * 屏上替换（渐进增强）：改写结果应用到播放器内存弹幕列表，
   * 使 canvas 下一帧重绘友善版。返回 false = 未能定位播放器列表（降级）。
   */
  applyLiveRewrites?(replacements: ReadonlyMap<string, string>): boolean;
  /** 启动屏上替换探测（播放器初始化可能需要时间，内部自定重试策略） */
  startLiveProbe?(): void;
}

export interface SiteCommentSelectors {
  /** 评论条目容器选择器（observer 兜底采集用） */
  root: string;
  /** 评论文本容器选择器 */
  content: string;
  /** 评论者昵称选择器 */
  author: string;
}

export interface SiteAdapter {
  /** 站点键（= enabledSites 配置值），如 'bilibili' */
  key: string;
  /** 用户可见名称，如 'Bilibili 评论区' */
  label: string;
  /** 站点域名匹配（manifest content_scripts.matches；entrypoint 内仍需字面量） */
  matches: string[];
  /** 评论 API URL 匹配（main world，劫持层） */
  matchReplyUrl(url: string): boolean;
  /** 评论响应提取（响应 JSON → CommentItem[]，零阻塞路径；seq 由适配器填充） */
  extractReplies(data: unknown, url: string): CommentItem[];
  /**
   * 按 id（rpid 等）定位评论 DOM 节点（isolated world，结果应用）。
   * seq = 接口响应索引（B 站新版评论区 DOM 无 rpid 属性，只能按顺序定位）。
   */
  resolveCommentRoot(id: string, seq?: number): HTMLElement | null;
  /**
   * 定位评论条目的文本容器（B 站评论文本在多层嵌套 shadow 的 bili-rich-text 内，
   * 通用选择器无法表达 → 适配器提供；返回 null 时回退 commentSelectors.content）
   */
  resolveContentNode?(root: HTMLElement): HTMLElement | null;
  /** 评论 DOM 选择器（isolated world，结果应用与兜底采集） */
  commentSelectors: SiteCommentSelectors;
  /** 弹幕能力（站点无弹幕则不提供） */
  danmaku?: SiteDanmakuAdapter;
}
