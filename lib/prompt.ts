/**
 * 强度 → Prompt 映射。
 * 架构级约定：mild 仅软化明显攻击性词汇；moderate 保持原意、中立语气；
 * strong 全面友善化、允许调整句式。
 */

import type { CustomStyle, Intensity, KindlyConfig } from './config.ts';
import { STYLE_PRESETS } from './config.ts';
import type { CommentItem } from './messages.ts';

/** buildMessages 只依赖的条目字段（PendingItem 与 CommentItem 均满足） */
type MessageItem = Pick<CommentItem, 'id' | 'author' | 'original'>;

const INTENSITY_RULES: Record<Intensity, string> = {
  mild: '只软化明显带有攻击性、侮辱性的词汇，尽量保持原有语气、句式和风格；不改变事实信息。',
  moderate: '保持原意与事实信息，将情绪化的攻击、阴阳怪气调整为中立、友善的表达。',
  strong: '全面友善化：允许调整句式结构，将负面情绪转化为温暖、理性、建设性的表达；不编造事实。',
};

/**
 * "原样返回"规则按输出风格切换：
 *  - 默认（仅改写，style 为空）：友善内容不加工，原样返回（既有行为）
 *  - 风格化（style 非空）：**统一改写**——所有条目都要套用风格重新表达，
 *    否则风格预设无法统一生效（用户要求；2026-08）
 */
function originalReturnRule(style: string): string {
  if (style) {
    return '所有条目都必须改写：即使是友善内容也要按风格要求重新表达（套用风格用语与语气）；仅当内容无实际语义（纯符号、表情、过短）时原样返回。';
  }
  return '若某条评论本身已友善，或内容无实际语义（纯符号、表情、过短），原样返回该文本。';
}

/**
 * 网络梗与流行语识别（评论/弹幕共用）。
 * 语料依据 comments/ 调研（2026-08：2010/2016/2019 B 站、2019 抖音、跨期通用黑话）。
 * 核心：区分"良性玩梗"（弹幕文化的正常表达，保留）与"恶意玩梗/阴阳怪气"（改写），
 * 避免把正常玩梗误判为攻击、或把梗式攻击原样放行。
 */
const MEME_RULE = `识别网络梗与流行语：B 站、抖音等平台有大量网络梗，按语境区分——
良性玩梗（表达喜爱/赞赏/调侃/感叹：如「awsl」「2333」「前方高能」「妙啊」「泪目」「名场面」「奥利给」「好嗨哟」「盘他」「我太难了」「双击666」「文艺复兴」「双厨狂喜」「我酸了/恰柠檬」「真香」「大佬」；以及应援句「XX 我老婆」「我永远喜欢 XX」、版聊句「前面的等等我」「+1」、科普句「野生字幕君」「课代表」等）→ 原样保留，不改写、不解释；
恶意玩梗（用梗贬损/羞辱特定对象：如「鸡你太美」「小黑子」「ikun」「坤」等刷屏贬损明星，或把梗变成群体攻击）→ 改写为不针对个人的中性表达；
阴阳怪气式玩梗（如「你品，你细品」「我不要你觉得，我要我觉得」被用于嘲讽、压制时）→ 改为直白友善表达，保留原意；
不确定某梗是否含攻击性时倾向保留，不要过度改写。`;

/**
 * 品牌/群体黑称识别（评论/弹幕共用，2026-08 新增品牌语境联想）。
 * 把群体攻击性标签改写为中性指代，保留理性批评。
 */
const SLUR_RULE = `识别品牌/群体黑称与谐音梗：充分结合品牌关联语境联想匹配——品牌/群体黑称与谐音梗（如「higo/海狗」「花粉/海军」指代华为用户，「米猴/猴米」指代小米用户，「果蛆/苹狗」指代苹果用户等）以及产品暗示性攻击（如「智商税」「爱国税」「买办」等阴阳怪气标签），改写为中性指代（如「华为用户」「小米用户」「该品牌用户」），保留理性批评但消除恶意标签与群体攻击；不要把正常品牌讨论误判为黑称。`;

/**
 * 解析当前选中的输出风格指令：内置预置取 STYLE_PRESETS.prompt，
 * 自定义风格按 styleId 在 customStyles 中查找；未知 id 回退空串（仅改写）。
 */
export function resolveStyleInstruction(
  config: Pick<KindlyConfig, 'styleId' | 'customStyles'>,
): string {
  const preset = STYLE_PRESETS.find((p) => p.id === config.styleId);
  if (preset) return preset.prompt;
  const custom = config.customStyles.find((c: CustomStyle) => c.id === config.styleId);
  return custom?.prompt.trim() ?? '';
}

export function buildMessages(
  config: Pick<KindlyConfig, 'intensity' | 'includeAuthor' | 'styleId' | 'customStyles' | 'emojiToKaomoji'>,
  items: MessageItem[],
  kind: 'comment' | 'danmaku' = 'comment',
): { role: 'system' | 'user'; content: string }[] {
  const rule = INTENSITY_RULES[config.intensity];
  const style = resolveStyleInstruction(config);
  const originalRule = originalReturnRule(style);
  // 注意：不要用「条件运算符 ? 多行模板字符串」——TypeScript 5.8.3 解析器
  // 对该组合会误报 TS1005（模板收尾处 ':' expected），用 if 语句规避。
  let system: string;
  if (kind === 'danmaku') {
    system = `你是一个「弹幕友善化助手」。用户会给你若干条视频弹幕，其中可能含有攻击性、侮辱性或阴阳怪气的表达。
请逐条将它们重写为友善、理性、保持原意的表达。输出规则：
1. 只输出一个 JSON 对象，键为弹幕 id，值为改写后的文本；不要输出任何多余文字，不要使用 Markdown 代码块标记。
2. 保持弹幕风格：简短（不超过 20 字）、口语化；不要添加原文没有的内容或解释。
3. ${originalRule}
4. ${MEME_RULE}
5. ${SLUR_RULE}
6. 改写力度：${rule}`;
  } else {
    system = `你是一个「友善改写器」。用户会给你若干条网络评论，其中可能含有攻击性、阴阳怪气或负面情绪。
请逐条将它们重写为友善、理性、保持原意的表达。输出规则：
1. 只输出一个 JSON 对象，键为评论 id，值为改写后的文本；不要输出任何多余文字，不要使用 Markdown 代码块标记。
2. ${originalRule}
3. ${MEME_RULE}
4. ${SLUR_RULE}
5. 不要添加原文没有的事实、观点或标签。
6. 改写力度：${rule}`;
  }
  // 追加规则：表情符号转颜文字（可选）→ 输出风格（可选），编号动态接续
  let extra = '';
  let next = 6;
  if (config.emojiToKaomoji) {
    extra += `\n${next}. 表情符号转颜文字：若文本中出现表情符号（emoji，如 😀😂😡👍❤️ 等），将其改写为对应情绪与含义的颜文字（kaomoji，如 (^_^)、(≧▽≦)、>_<、(╥﹏╥) 等），与文本自然融合；原文没有表情符号时不要凭空添加。`;
    next++;
  }
  if (style) {
    extra += `\n${next}. 输出风格：${style}`;
  }
  system += extra;

  const payload = items.map((it) =>
    config.includeAuthor && it.author ? { id: it.id, author: it.author, text: it.original } : { id: it.id, text: it.original },
  );
  const noun = kind === 'danmaku' ? '弹幕' : '评论';
  return [
    { role: 'system', content: system },
    { role: 'user', content: `请改写以下${noun}，严格以 JSON 对象返回：\n${JSON.stringify(payload)}` },
  ];
}
