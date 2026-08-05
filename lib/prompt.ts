/**
 * 强度 → Prompt 映射（docs/ARCHITECTURE.md §6）。
 * 架构级约定：mild 仅软化明显攻击性词汇；moderate 保持原意、中立语气；
 * strong 全面友善化、允许调整句式。
 */

import type { Intensity, KindlyConfig } from './config';
import type { CommentItem } from './messages';

/** buildMessages 只依赖的条目字段（PendingItem 与 CommentItem 均满足） */
type MessageItem = Pick<CommentItem, 'id' | 'author' | 'original'>;

const INTENSITY_RULES: Record<Intensity, string> = {
  mild: '只软化明显带有攻击性、侮辱性的词汇，尽量保持原有语气、句式和风格；不改变事实信息。',
  moderate: '保持原意与事实信息，将情绪化的攻击、阴阳怪气调整为中立、友善的表达。',
  strong: '全面友善化：允许调整句式结构，将负面情绪转化为温暖、理性、建设性的表达；不编造事实。',
};

export function buildMessages(
  config: Pick<KindlyConfig, 'intensity' | 'includeAuthor'>,
  items: MessageItem[],
  kind: 'comment' | 'danmaku' = 'comment',
): { role: 'system' | 'user'; content: string }[] {
  const rule = INTENSITY_RULES[config.intensity];
  // 注意：不要用「条件运算符 ? 多行模板字符串」——TypeScript 5.8.3 解析器
  // 对该组合会误报 TS1005（模板收尾处 ':' expected），用 if 语句规避。
  let system: string;
  if (kind === 'danmaku') {
    system = `你是一个「弹幕友善化助手」。用户会给你若干条视频弹幕，其中可能含有攻击性、侮辱性或阴阳怪气的表达。
请逐条将它们重写为友善、理性、保持原意的表达。输出规则：
1. 只输出一个 JSON 对象，键为弹幕 id，值为改写后的文本；不要输出任何多余文字，不要使用 Markdown 代码块标记。
2. 保持弹幕风格：简短（不超过 20 字）、口语化；不要添加原文没有的内容或解释。
3. 若某条弹幕本身已友善，或内容无实际语义（纯符号、表情、过短），原样返回该文本。
4. 改写力度：${rule}`;
  } else {
    system = `你是一个「友善改写器」。用户会给你若干条网络评论，其中可能含有攻击性、阴阳怪气或负面情绪。
请逐条将它们重写为友善、理性、保持原意的表达。输出规则：
1. 只输出一个 JSON 对象，键为评论 id，值为改写后的文本；不要输出任何多余文字，不要使用 Markdown 代码块标记。
2. 若某条评论本身已友善，或内容无实际语义（纯符号、表情、过短），原样返回该文本。
3. 不要添加原文没有的事实、观点或标签。
4. 改写力度：${rule}`;
  }

  const payload = items.map((it) =>
    config.includeAuthor && it.author ? { id: it.id, author: it.author, text: it.original } : { id: it.id, text: it.original },
  );
  const noun = kind === 'danmaku' ? '弹幕' : '评论';
  return [
    { role: 'system', content: system },
    { role: 'user', content: `请改写以下${noun}，严格以 JSON 对象返回：\n${JSON.stringify(payload)}` },
  ];
}
