/**
 * 运行时消息协议（docs/ARCHITECTURE.md §6）。
 * CommentItem 为 content script ↔ SW 的传输 DTO；DOM 节点不跨消息，
 * CS 侧维护 Map<id, HTMLElement> 注册表，消息只传 id。
 */

export interface CommentItem {
  /** 发送方保证唯一：评论场景为 rpid 字符串，弹幕场景为 idStr */
  id: string;
  /** 评论者昵称（是否发送由 includeAuthor 决定） */
  author: string;
  /** 评论原文 */
  original: string;
  /** 改写结果（success 时填充；等于原文表示无意义改写，CS 保留原文） */
  rewritten?: string;
  status: 'pending' | 'success' | 'error';
  error?: 'auth' | 'rate_limited' | 'timeout' | 'network' | 'parse' | 'empty';
  /** 内容类型：评论（逐条回发）或弹幕（按批聚合回发） */
  kind?: 'comment' | 'danmaku';
  /** 弹幕批量请求的聚合 ID（存在时 SW 聚合结果而非逐条回发） */
  requestId?: string;
  /**
   * 评论在接口响应/页面渲染列表中的顺序索引（B 站新版评论区 DOM 无 rpid 属性，
   * 结果应用按接口顺序 ↔ #feed 内 thread renderer 顺序定位）
   */
  seq?: number;
}

export type RewriteReason = NonNullable<CommentItem['error']>;

export type RuntimeMessage =
  | { type: 'KW_REWRITE_COMMENTS'; items: CommentItem[] } // CS → SW
  | { type: 'KW_REWRITE_BATCH'; requestId: string; kind: 'danmaku'; items: CommentItem[] } // main-world → SW
  | { type: 'KW_REWRITE_BATCH_RESULT'; requestId: string; results: { id: string; rewritten: string }[] } // SW → tab
  | { type: 'KW_REWRITE_RESULT'; id: string; rewritten: string; seq?: number } // SW → CS
  | { type: 'KW_REWRITE_ERROR'; id: string; reason: RewriteReason; detail?: string; seq?: number } // SW → CS
  | { type: 'KW_SET_ENABLED'; enabled: boolean } // popup → SW → tabs
  | { type: 'KW_CONFIG_CHANGED' } // options/onboarding → SW → tabs
  | { type: 'KW_HIJACK_ACTIVE' } // main-world hijack → isolated CS（劫持已生效，跳过 observer 兜底）
  | { type: 'KW_GET_STATUS' } // popup → SW
  | {
      type: 'KW_STATUS';
      queueLength: number;
      inFlight: number;
      failures: number;
      totalRewritten: number;
      paused: boolean;
      authFailed: boolean;
      lastError: RewriteReason | null;
    } // SW → popup
  | { type: 'KW_TEST_CONNECTION' } // onboarding/options → SW
  | {
      type: 'KW_TEST_RESULT';
      ok: boolean;
      model?: string;
      latencyMs?: number;
      error?: RewriteReason | 'auth';
    }; // SW → 请求方

export type TestResult = Extract<RuntimeMessage, { type: 'KW_TEST_RESULT' }>;
export type StatusPayload = Extract<RuntimeMessage, { type: 'KW_STATUS' }>;

/** 内容脚本收到配置/开关变化时重新读取配置 */
export const MSG_SET_ENABLED = 'KW_SET_ENABLED';
export const MSG_CONFIG_CHANGED = 'KW_CONFIG_CHANGED';
export const MSG_REWRITE_RESULT = 'KW_REWRITE_RESULT';
export const MSG_REWRITE_ERROR = 'KW_REWRITE_ERROR';
