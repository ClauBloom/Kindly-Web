/**
 * B 站适配器：评论路径（URL 匹配、响应提取、DOM 定位、采集选择器）。
 *
 * 维护点（2026-08 实测）：
 *  - 评论接口 URL：/x/v2/reply/wbi/main（wbi 签名版）、/x/v2/reply/reply（楼中楼）
 *  - 响应结构：data.replies[].{rpid, member.uname, content.message}（plain text，多行）；
 *    main 接口顶层 replies[i] 内嵌 replies[].replies（楼中楼预览 ≤3 条）；
 *    reply 接口 data.root.rpid = 父顶层评论，data.replies = 该楼中楼全部回复
 *  - DOM 结构：评论区整体渲染在 <bili-comments> 的 Lit shadow root 内，多层嵌套：
 *      bili-comments (shadow) → #feed > bili-comment-thread-renderer (shadow)
 *        → bili-comment-renderer#comment (shadow) → #content > bili-rich-text (shadow)
 *        → <p id="contents"><span>评论文本</span></p>
 *      楼中楼：thread (shadow) → div#replies > bili-comment-replies-renderer (shadow)
 *        → div#expander > div#expander-contents > bili-comment-reply-renderer (shadow)
 *        → div#body > bili-rich-text (shadow) → #contents
 *    评论 DOM **没有 rpid 属性** → 结果应用按"接口顺序 ↔ 渲染顺序"定位：
 *    顶层 = seq（#feed 内 thread 索引）；楼中楼 = path（[顶层 seq, 楼中楼内索引]）。
 *    "查看全部回复"后列表替换会令旧索引偏移 → 定位时按原文文本兜底匹配。
 */

import type { CommentItem } from '@/lib/messages';
import type { SiteAdapter } from './types.ts';

const REPLY_RE = /\/x\/v2\/reply\/(?:wbi\/)?(main|reply)/;
const MAIN_REPLY_RE = /\/x\/v2\/reply\/(?:wbi\/)?main/;

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
  replies?: ReplyShape[];
}

const MIN_TEXT_LENGTH = 2;

/**
 * 评论/弹幕文本规范化：去掉 [表情] 标记（B 站把 [doge] 等渲染为图片，
 * DOM textContent 中不含标记）并压缩空白。用于 DOM 文本与接口原文的匹配。
 */
export function normalizeCommentText(text: string): string {
  return text.replace(/\[[^\]\n]{1,20}\]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 顶层评论 rpid → 其在 #feed 中的线程索引。
 * main 接口被劫持时建立；reply 接口（楼中楼）提取时借以定位父线程。
 * 仅 main world 劫持层实例维护（isolated 实例不调用 extractReplies）。
 */
const rpidSeqMap = new Map<string, number>();

function replyItem(r: ReplyShape, path: number[], seq?: number): CommentItem | null {
  const message = r?.content?.message;
  if (typeof message !== 'string') return null;
  const text = message.trim();
  if (text.length < MIN_TEXT_LENGTH) return null;
  return {
    id: String(r.rpid ?? crypto.randomUUID()),
    author: r?.member?.uname ?? '',
    original: text,
    status: 'pending',
    seq,
    path,
  };
}

/**
 * 提取评论（置顶 + 顶层 + 第一层楼中楼）：
 *  - DOM 渲染顺序 = top_replies（置顶，在前）→ replies（在后），seq 必须与之一致
 *  - top_replies[i] → path [i]、seq i；其内嵌 replies[j] → path [i, j]
 *  - main 接口 replies[i] → path [置顶数 + i]、seq 同；内嵌 replies[].replies[j] → path [置顶数 + i, j]
 *  - reply 接口：data.replies[k] → path [父线程索引, k]（父线程索引来自 main 劫持时建立的 rpid→seq 映射）
 *  - 第二层（回复的回复，replies[].replies 内嵌）不提取：其展开 DOM 结构未纳入定位，避免错位
 */
export function extractBilibiliReplies(data: unknown, url: string): CommentItem[] {
  const payload = (data as { data?: { replies?: ReplyShape[]; root?: ReplyShape; top_replies?: ReplyShape[] } })?.data;
  const isMain = MAIN_REPLY_RE.test(url);
  const items: CommentItem[] = [];
  if (isMain) {
    // 置顶评论渲染在评论区最前（实测 2026-08），先于 replies 编序
    const topReplies = payload?.top_replies ?? [];
    for (const [i, r] of topReplies.entries()) {
      if (r?.rpid !== undefined) rpidSeqMap.set(String(r.rpid), i);
      const top = replyItem(r, [i], i);
      if (top) items.push(top);
      for (const [j, sub] of (r?.replies ?? []).entries()) {
        const item = replyItem(sub, [i, j]);
        if (item) items.push(item);
      }
    }
    const offset = topReplies.length;
    for (const [i, r] of (payload?.replies ?? []).entries()) {
      const seq = offset + i;
      if (r?.rpid !== undefined) rpidSeqMap.set(String(r.rpid), seq);
      const top = replyItem(r, [seq], seq);
      if (top) items.push(top);
      for (const [j, sub] of (r?.replies ?? []).entries()) {
        const item = replyItem(sub, [seq, j]);
        if (item) items.push(item);
      }
    }
    return items;
  }
  // 楼中楼接口：拿不到父线程位置 → 不提取（页面未加载 main 或映射丢失，保持原样）
  const parentRpid = payload?.root?.rpid;
  const parentSeq = parentRpid === undefined ? undefined : rpidSeqMap.get(String(parentRpid));
  if (parentSeq === undefined) return [];
  for (const [k, r] of (payload?.replies ?? []).entries()) {
    const item = replyItem(r, [parentSeq, k]);
    if (item) items.push(item);
  }
  return items;
}

/** 顶层线程定位：#feed 的第 seq 个 bili-comment-thread-renderer */
function findTopThread(seq: number): HTMLElement | null {
  try {
    const bc = document.querySelector('bili-comments');
    const feed = bc?.shadowRoot?.querySelector<HTMLElement>('#feed');
    const threads = feed ? [...feed.children].filter((el) => el.tagName === 'BILI-COMMENT-THREAD-RENDERER') : [];
    return (threads[seq] as HTMLElement | undefined) ?? null;
  } catch {
    return null;
  }
}

/** 全部顶层线程（文本匹配回退用） */
function allTopThreads(): HTMLElement[] {
  try {
    const bc = document.querySelector('bili-comments');
    const feed = bc?.shadowRoot?.querySelector<HTMLElement>('#feed');
    return feed ? [...feed.children].filter((el): el is HTMLElement => el.tagName === 'BILI-COMMENT-THREAD-RENDERER') : [];
  } catch {
    return [];
  }
}

/** 顶层评论文本（穿透 shadow 取 #contents） */
function topThreadText(el: Element): string {
  try {
    const renderer = el.shadowRoot?.querySelector('bili-comment-renderer#comment');
    const rich = renderer?.shadowRoot?.querySelector('#content bili-rich-text');
    return rich?.shadowRoot?.querySelector<HTMLElement>('#contents')?.textContent?.trim() ?? '';
  } catch {
    return '';
  }
}

/** 楼中楼文本（shadow 穿透取 #contents 文本） */
function replyText(el: Element): string {
  try {
    const rich = el.shadowRoot?.querySelector('bili-rich-text');
    return rich?.shadowRoot?.querySelector<HTMLElement>('#contents')?.textContent?.trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * 定位评论 DOM 节点：
 *  - path 存在：path[0] 定位顶层线程，path[1] 定位其楼中楼列表内的回复；
 *    索引位文本与 original 不符时（"查看全部回复"替换列表/评论区重排导致索引偏移）
 *    按原文文本兜底匹配（规范化比较，忽略 [表情] 差异）
 *  - 仅 seq：顶层线程（原有逻辑）
 *  - 兜底：rpid 属性查找（数据属性由结果应用写入）
 */
export function resolveBilibiliCommentRoot(id: string, seq?: number, path?: number[], original?: string): HTMLElement | null {
  if (path && path.length > 0) {
    const topSeq = path[0];
    if (topSeq === undefined) return null;
    if (path.length === 1) {
      // 顶层评论：path=[i]（与 seq 等价）
      const thread = findTopThread(topSeq);
      if (!thread) return null;
      if (original && normalizeCommentText(topThreadText(thread)) !== normalizeCommentText(original)) {
        // seq 错位（评论区滚动重排）：按原文文本在全部线程中匹配（优先未登记的结果）
        const match = allTopThreads().find(
          (t) => normalizeCommentText(topThreadText(t)) === normalizeCommentText(original) && !t.dataset.kwId,
        );
        return match ?? null;
      }
      return thread;
    }
    // 楼中楼：path=[顶层 seq, 楼中楼内索引]
    const thread = findTopThread(topSeq);
    if (!thread) return null;
    try {
      const er = thread.shadowRoot?.querySelector('div#replies bili-comment-replies-renderer');
      const list = er?.shadowRoot?.querySelector('div#expander div#expander-contents');
      const replies = list
        ? [...list.children].filter((el): el is HTMLElement => el.tagName === 'BILI-COMMENT-REPLY-RENDERER')
        : [];
      const index = path[1] ?? 0;
      const el = (replies[index] as HTMLElement | undefined) ?? null;
      if (!el) return null;
      if (original && normalizeCommentText(replyText(el)) !== normalizeCommentText(original)) {
        const match = replies.find(
          (r) => normalizeCommentText(replyText(r)) === normalizeCommentText(original) && !r.dataset.kwId,
        );
        return match ?? null;
      }
      return el;
    } catch {
      return null;
    }
  }
  if (typeof seq === 'number') return findTopThread(seq);
  // rpid 属性查找（seq/path 定位失败时的回退）
  try {
    return document.querySelector<HTMLElement>(
      `[rpid="${CSS.escape(id)}"], [data-rpid="${CSS.escape(id)}"]`,
    );
  } catch {
    return null;
  }
}

/** 文本容器：顶层与楼中楼同为 bili-rich-text 的 shadow 内 #contents（<p id="contents">…</p>） */
export function resolveBilibiliContentNode(root: HTMLElement): HTMLElement | null {
  try {
    // 顶层：bili-comment-renderer#comment (shadow) → #content bili-rich-text (shadow) → #contents
    const renderer = root.shadowRoot?.querySelector<HTMLElement>('bili-comment-renderer#comment');
    const richTop = renderer?.shadowRoot?.querySelector<HTMLElement>('#content bili-rich-text');
    if (richTop?.shadowRoot) {
      return richTop.shadowRoot.querySelector<HTMLElement>('#contents') ?? null;
    }
    // 楼中楼：div#body bili-rich-text (shadow) → #contents
    const richSub = root.shadowRoot?.querySelector<HTMLElement>('div#body bili-rich-text');
    if (richSub?.shadowRoot) {
      return richSub.shadowRoot.querySelector<HTMLElement>('#contents') ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 昵称节点：顶层 bili-comment-renderer (shadow) 内；楼中楼 reply-renderer (shadow) 内 */
export function resolveBilibiliAuthorNode(root: HTMLElement): HTMLElement | null {
  try {
    const renderer = root.shadowRoot?.querySelector<HTMLElement>('bili-comment-renderer#comment');
    const top = renderer?.shadowRoot?.querySelector<HTMLElement>('bili-comment-user-info');
    if (top) return top;
    return root.shadowRoot?.querySelector<HTMLElement>('div#body bili-comment-user-info') ?? null;
  } catch {
    return null;
  }
}

export const bilibiliAdapter: SiteAdapter = {
  key: 'bilibili',
  label: 'Bilibili 评论区',
  danmakuLabel: 'Bilibili 弹幕',
  matches: BILIBILI_MATCHES,
  matchReplyUrl: (url) => REPLY_RE.test(url),
  extractReplies: extractBilibiliReplies,
  resolveCommentRoot: resolveBilibiliCommentRoot,
  resolveContentNode: resolveBilibiliContentNode,
  resolveAuthorNode: resolveBilibiliAuthorNode,
  normalizeText: normalizeCommentText,
  commentSelectors: BILIBILI_COMMENT_SELECTORS,
  videoMeta: {
    matchUrl: (url) => /\/x\/web-interface\/(?:wbi\/)?view/.test(url),
    extractDanmakuTotal: (data) => {
      const d = data as { data?: { stat?: { danmaku?: unknown }; View?: { stat?: { danmaku?: unknown } } } };
      const total = d?.data?.stat?.danmaku ?? d?.data?.View?.stat?.danmaku;
      return typeof total === 'number' && total > 0 ? total : null;
    },
    // B 站新版页面不再请求 view 接口（实测 2026-08）：视频信息内嵌于 SSR 全局
    extractDanmakuTotalFromPage: () => {
      try {
        const win = window as unknown as { __INITIAL_STATE__?: unknown };
        const raw = win.__INITIAL_STATE__;
        if (!raw) return null;
        const state = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
        const total = (state as { videoData?: { stat?: { danmaku?: unknown } } })?.videoData?.stat?.danmaku;
        return typeof total === 'number' && total > 0 ? total : null;
      } catch {
        return null;
      }
    },
  },
};
