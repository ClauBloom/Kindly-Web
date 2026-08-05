/**
 * 极简 i18n 抽象（v1 仅中文；预留结构，后续加语言只需新增字典）。
 * UI 文案集中在 zh 字典，popup / options / onboarding 共享同一术语表。
 */

const zh: Record<string, string> = {
  // 品牌
  'brand.name': 'Kindly Web',
  'brand.slogan': '把戾气，改写为友善。',
  'brand.privacy': '评论原文只发给你自己配置的 API。',

  // popup
  'popup.unconfigured.cta': '开始设置',
  'popup.openSettings': '打开设置',
  'popup.toggle.on': '正在改写评论',
  'popup.toggle.off': '已暂停改写',
  'popup.intensity': '改写强度',
  'popup.intensity.mild': '温和',
  'popup.intensity.moderate': '适中',
  'popup.intensity.strong': '强力',
  'popup.status.queue': '队列',
  'popup.status.inflight': '进行中',
  'popup.status.failures': '失败',
  'popup.status.rewritten': '已改写',
  'popup.status.idle': '空闲',
  'popup.paused.warn': '已暂停：API 频繁报错，请稍后再试',
  'popup.auth.warn': 'API Key 无效，请在设置中检查',
  'popup.visitBilibili': '打开 B 站',
  'popup.statusTitle': '队列状态',

  // 强度描述（popup 悬停 / onboarding / options）
  'intensity.mild.desc': '只软化明显攻击性词汇，保持语气',
  'intensity.moderate.desc': '保持原意，调整为中立友善语气',
  'intensity.strong.desc': '全面友善化，允许调整句式结构',

  // 通用按钮
  'btn.next': '下一步',
  'btn.back': '上一步',
  'btn.skip': '跳过引导',
  'btn.save': '保存设置',
  'btn.saved': '已保存',
  'btn.test': '测试连接',
  'btn.testing': '测试中…',

  // onboarding 步骤
  'onb.step1.title': '欢迎使用 Kindly Web',
  'onb.step1.desc': '浏览网页时，自动把评论里的攻击与戾气，重写为友善的表达。',
  'onb.step1.privacy.title': '隐私承诺',
  'onb.step1.privacy.p1': 'API Key 只存在本机，只在你配置的 API 请求中使用；',
  'onb.step1.privacy.p2': '评论原文只发送到你配置的服务商；',
  'onb.step1.privacy.p3': '扩展不收集任何数据，随时可卸载。',
  'onb.step1.cta': '开始配置',
  'onb.step2.title': '连接你的大模型',
  'onb.step2.subtitle': '选择服务商，填入 API Key。原文只发往这里。',
  'onb.step2.key.placeholder': 'sk-…',
  'onb.step2.key.missing': '请填写 API Key',
  'onb.step2.permission.need': '该地址需要授权网络权限，点击下一步时浏览器会弹出确认',
  'onb.step3.title': '测试连接',
  'onb.step3.desc': '将通过扩展的后台安全地发送一个最小请求。',
  'onb.step3.ok': '连接成功 · {model} · {latency}ms',
  'onb.step3.fail': '连接失败：{reason}',
  'onb.step3.skipTest': '跳过测试',
  'onb.step4.title': '选择改写偏好',
  'onb.step4.intensity': '改写强度',
  'onb.step4.mode': '展示方式',
  'onb.step4.mode.replace': '原地替换',
  'onb.step4.mode.replace.desc': '直接改写页面评论，悬停查看原文',
  'onb.step4.mode.bubble': '仅浮层对比',
  'onb.step4.mode.bubble.desc': '不动原文，悬停显示改写建议',
  'onb.step4.sites': '启用站点',
  'onb.step5.title': '一切就绪',
  'onb.step5.desc': '去 B 站评论区看看效果吧。悬停改写后的评论可以查看原文。',
  'onb.step5.cta': '打开 B 站看效果',
  'onb.step5.options': '去配置页',

  // options
  'opt.api.title': 'API 设置',
  'opt.api.provider': '服务商',
  'opt.api.baseURL': '接口地址 (Base URL)',
  'opt.api.model': '模型名称',
  'opt.api.key': 'API Key',
  'opt.api.key.hint': '当前密钥尾号 ···{tail}',
  'opt.api.custom.note': '自定义域名首次保存时需授权网络权限',
  'opt.rewrite.title': '重写偏好',
  'opt.rewrite.batchSize': '每批评论数',
  'opt.rewrite.timeout': '请求超时（秒）',
  'opt.rewrite.includeAuthor': '把评论者昵称一起发送（用于语境，可能涉及昵称隐私）',
  'opt.sites.title': '站点管理',
  'opt.data.title': '数据与隐私',
  'opt.data.cache': '本地改写缓存：{count} 条',
  'opt.data.clearCache': '清除缓存',
  'opt.data.privacy': '评论原文仅发送至你配置的 API；扩展自身不收集、不上传任何数据。',
  'opt.data.threat': '说明：chrome.storage 未加密，本机 profile 可读；扩展防护的是网页脚本嗅探，而非本机攻击者。',
  'opt.data.reviewOnboarding': '重新查看引导',
  'opt.status.auth': 'API Key 无效，无法连接服务商',
  'opt.status.customPermission': '已为该地址授权网络权限',

  // 测试连接错误分类
  'err.auth': 'API Key 无效或未配置',
  'err.rate_limited': '请求过于频繁，请稍后再试',
  'err.timeout': '请求超时，请检查网络或接口地址',
  'err.network': '无法连接该地址，请检查网络与 Base URL',
  'err.parse': '服务商返回格式异常',
  'err.empty': '服务商返回为空',
};

export function t(key: string, vars?: Record<string, string | number>): string {
  let text = zh[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}
