/**
 * 本地攻击性过滤器（弹幕场景）。
 *
 * 用途：弹幕量大，不能全量送 LLM —— 先本地筛出"疑似攻击性"弹幕，
 * 仅命中者送改写（召回优先，宁可多送；LLM 侧有"本身友善则原文返回"规则兜底）。
 * 评论不过滤（评论全量改写，缓存去重）。
 */

// 命中即疑似攻击的核心词（按字符匹配，大小写不敏感）
const CORE_TERMS = [
  '傻逼', '煞笔', '傻比', '脑残', '智障', '弱智', '白痴', '蠢货', '废物', '垃圾人',
  '去死', '吃屎', '吃翔', '贱人', '婊子', '荡妇', '杂种', '畜生', '狗逼', '狗东西',
  '尼玛', '你妈', '他妈', '草泥马', '妈的', '娘炮', '娘娘腔', '丑八怪', '死胖子',
  '滚出', '滚蛋', '闭嘴', '眼瞎', '聋了', '手残', '脑残粉', '恶心', '呕吐', '呕',
  '吐了', '恶臭', '烂片', '垃圾玩意', '什么玩意', '什么鬼', '你有病', '有病吧',
  '脑子有', '没脑子', '不长脑子', '猪脑子', '狗脑子', '蠢死', '气死', '笑死',
  'SB', 'sb', 'CNM', 'NMSL', 'WQNMLGB', 'MDZZ', 'fuck', 'FUCK', 'shit', 'SHIT',
  'bitch', 'BITCH', 'asshole', 'ASSHOLE', '草', '艹', '靠', '操',
];

// 启发式：连续感叹号（中英文）、全大写等（激动/攻击情绪信号）
function heuristicHits(text: string): number {
  let hits = 0;
  const exclaims = (text.match(/[!！]{3,}/g) ?? []).length;
  if (exclaims > 0) hits += exclaims;
  if (/^[A-Z\s!]{6,}$/.test(text)) hits += 1;
  if (/[a-z]{2,}是(狗|猪|傻|蠢)/.test(text)) hits += 1;
  return hits;
}

/** 判断弹幕是否疑似攻击性（true → 送 LLM 改写） */
export function isSuspiciousDanmaku(text: string): boolean {
  const t = text.trim();
  if (t.length < 2 || t.length > 60) return false; // 太短/过长（颜文字、长文）不处理
  if (heuristicHits(t) > 0) return true;
  return CORE_TERMS.some((term) => t.includes(term));
}
