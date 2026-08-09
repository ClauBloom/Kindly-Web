/**
 * B 站适配器：评论路径（URL 匹配、响应提取、DOM 定位、采集选择器）。
 *
 * 维护点（2026-08 实测）：
 *  - 评论接口 URL：/x/v2/reply/wbi/main（wbi 签名版）、/x/v2/reply/reply（楼中楼）
 *  - 响应结构：data.replies[].{rpid, member.uname, content.message}（plain text，多行）
 *  - DOM 结构：评论区整体渲染在 <bili-comments> 的 Lit shadow root 内，多层嵌套：
 *      bili-comments (shadow) → #feed > bili-comment-thread-renderer (shadow)
 *        → bili-comment-renderer#comment (shadow) → #content > bili-rich-text (shadow)
 *        → <p id="contents"><span>评论文本</span></p>
 *    评论 DOM **没有 rpid 属性** → 结果应用按"接口 replies 顺序 ↔ #feed 内
 *    thread renderer 顺序"（seq）定位。楼中楼线程不在 #feed 直接子级，不做改写。
 */

import type { CommentItem } from '@/lib/messages';
import type { SiteAdapter } from './types.ts';

const REPLY_RE = /\/x\/v2\/reply\/(?:wbi\/)?(main|reply)/;
/** 楼中楼接口（其 replies 是回复而非顶层评论，DOM 定位与顶层不一致，跳过改写） */
const SUB_REPLY_RE = /\/x\/v2\/reply\/(?:wbi\/)?reply/;

export const BILIBILI_COMMENT_SELECTORS = {
  /** 顶层评论线程（仅 #feed 的直接子级；queryShadowAll 负责穿透 shadow） */
  root: '#feed > bili-comment-thread-renderer',
  /** 评论文本容器（resolveContentNode 优先，此处为回退选择器） */
  content: '.reply-content, .reply-content-container, #content',
  /** 评论者昵称（回退选择器） */
  author: '.user-name, .reply-info .user-name, bili-comment-user-info',
} as const;

export const BILIBILI_MATCHES = ['https://www.bilibili.com/*', 'https://t.bilibili.com/*'];

interface ReplyShape {
  rpid?: number | string;
  member?: { uname?: string };
  content?: { message?: string };
}

const MIN_TEXT_LENGTH = 2;

export function extractBilibiliReplies(data: unknown, url: string): CommentItem[] {
  if (SUB_REPLY_RE.test(url)) return []; // 楼中楼：不提取（DOM 定位不支持）
  const replies = (data as { data?: { replies?: ReplyShape[] } })?.data?.replies ?? [];
  const items: CommentItem[] = [];
  for (const [i, r] of replies.entries()) {
    const message = r?.content?.message;
    if (typeof message !== 'string') continue;
    const text = message.trim();
    if (text.length < MIN_TEXT_LENGTH) continue;
    items.push({
      id: String(r.rpid ?? crypto.randomUUID()),
      author: r?.member?.uname ?? '',
      original: text,
      status: 'pending',
      seq: i,
    });
  }
  return items;
}

/** 按顺序定位顶层评论线程：#feed 的第 seq 个 bili-comment-thread-renderer */
export function resolveBilibiliCommentRoot(id: string, seq?: number): HTMLElement | null {
  if (typeof seq === 'number') {
    try {
      const bc = document.querySelector('bili-comments');
      const feed = bc?.shadowRoot?.querySelector<HTMLElement>('#feed');
      const threads = feed ? [...feed.children].filter((el) => el.tagName === 'BILI-COMMENT-THREAD-RENDERER') : [];
      return (threads[seq] as HTMLElement | undefined) ?? null;
    } catch {
      return null;
    }
  }
  // rpid 属性查找（seq 定位失败时的回退）
  try {
    return document.querySelector<HTMLElement>(
      `[rpid="${CSS.escape(id)}"], [data-rpid="${CSS.escape(id)}"]`,
    );
  } catch {
    return null;
  }
}

/** 文本容器：bili-rich-text 的 shadow 内 #contents（<p id="contents"><span>…</span></p>） */
export function resolveBilibiliContentNode(root: HTMLElement): HTMLElement | null {
  try {
    const renderer = root.shadowRoot?.querySelector<HTMLElement>('bili-comment-renderer#comment');
    const richText = renderer?.shadowRoot?.querySelector<HTMLElement>('#content bili-rich-text');
    return richText?.shadowRoot?.querySelector<HTMLElement>('#contents') ?? null;
  } catch {
    return null;
  }
}

export const bilibiliAdapter: SiteAdapter = {
  key: 'bilibili',
  label: 'Bilibili 评论区',
  matches: BILIBILI_MATCHES,
  matchReplyUrl: (url) => REPLY_RE.test(url),
  extractReplies: extractBilibiliReplies,
  resolveCommentRoot: resolveBilibiliCommentRoot,
  resolveContentNode: resolveBilibiliContentNode,
  commentSelectors: BILIBILI_COMMENT_SELECTORS,
  videoMeta: {
    matchUrl: (url) => /\/x\/web-interface\/(?:wbi\/)?view/.test(url),
    extractDanmakuTotal: (data) => {
      const d = data as { data?: { stat?: { danmaku?: unknown }; View?: { stat?: { danmaku?: unknown } } } };
      const total = d?.data?.stat?.danmaku ?? d?.data?.View?.stat?.danmaku;
      return typeof total === 'number' && total > 0 ? total : null;
    },
  },
};
