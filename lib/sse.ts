/**
 * SSE（Server-Sent Events）流式解析：OpenAI 兼容接口的 chat/completions
 * stream 响应为 `data: {…}` 行序列（choices[0].delta.content 增量累加，
 * 末尾 `data: [DONE]`）。本模块只做"SSE 文本 → 完整 content"的纯提取，
 * 供 SW 请求层累积流块后调用（framework-free，node 可测）。
 */

/**
 * 从完整 SSE 响应文本中提取 choices[0].delta.content 的拼接结果。
 * 忽略非 data 行（event:/注释/空行）与无法解析的行；[DONE] 后不再累积。
 */
export function extractSseContent(sseText: string): string {
  let content = '';
  let finished = false;
  for (const rawLine of sseText.split('\n')) {
    if (finished) break;
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      finished = true;
      break;
    }
    if (!payload) continue;
    try {
      const obj = JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] };
      const delta = obj.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') content += delta;
    } catch {
      // 非 JSON 的 data 行（如错误透传），忽略
    }
  }
  return content;
}

/**
 * 流式 SSE 增量读取器：跨 chunk 缓冲不完整行，逐行提取 delta.content。
 * 供 SW 流式循环把每块到达的 content 增量喂给增量 JSON 解析器，
 * 实现"每条结果到达即交付"（整块喂 extractSseContent 会因 chunk 边界
 * 截断行而丢内容）。
 */
export function createSseContentReader(): { push(chunk: string): string } {
  let lineBuf = '';
  let finished = false;
  return {
    push(chunk: string): string {
      if (finished) return '';
      lineBuf += chunk;
      let delta = '';
      let idx: number;
      while ((idx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, idx).trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            finished = true;
            break;
          }
          if (payload) {
            try {
              const obj = JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] };
              const d = obj.choices?.[0]?.delta?.content;
              if (typeof d === 'string') delta += d;
            } catch {
              // 非 JSON 行忽略
            }
          }
        }
      }
      return delta;
    },
  };
}
