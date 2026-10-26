/**
 * 输入文本归一化。
 * 从浏览器控制台 / 日志 / Windows 剪贴板复制出来的内容经常带 BOM、CRLF、零宽字符，
 * 直接送进解析器会出现"看着一模一样却解析失败"的情况，统一在这里处理。
 */

/** 去掉 BOM / CRLF / 零宽字符，保留换行结构 */
export function normalizeInput(text: string): string {
  if (!text) return text;
  return text
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n');
}

/** 单行输入（Cron 表达式 / 日期 / 正则等）：换行与连续空白压成单个空格 */
export function toSingleLine(text: string): string {
  return normalizeInput(text).replace(/\s+/g, ' ').trim();
}
