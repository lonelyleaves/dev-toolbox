/**
 * 软换行行号计算。
 * 输入框允许自动换行后，一个"逻辑行"可能占用多个"视觉行"；
 * 行号栏必须在逻辑行起始视觉行显示编号，续行留空，才能和文本严格对齐。
 *
 * 计算方式：按等宽字体的字符步进宽度做贪心折行估算。
 * 拉丁字符 = chWidth，CJK / 全角 / emoji = wideWidth，Tab = tabSize * chWidth。
 */

/** 粗略判断全角字符（等宽字体里通常占两个字符宽度） */
export function isWideChar(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * 计算每个逻辑行占用的视觉行数。
 * contentWidth <= 0（不可见 / 还没布局）时按 1 行处理。
 */
export function countWrappedRows(
  text: string,
  contentWidth: number,
  chWidth: number,
  wideWidth = chWidth * 2,
  tabSize = 4,
): number[] {
  const logicalLines = text.split('\n');
  if (!(contentWidth > 0) || !(chWidth > 0)) return logicalLines.map(() => 1);
  const tabWidth = chWidth * tabSize;
  return logicalLines.map((line) => {
    let used = 0;
    let rows = 1;
    for (const ch of line) {
      const w = ch === '\t' ? tabWidth : isWideChar(ch) ? wideWidth : chWidth;
      // 浏览器折行发生在"放下这个字符就超宽"的位置
      if (used + w > contentWidth + 0.01) {
        rows++;
        used = w;
      } else {
        used += w;
      }
    }
    return rows;
  });
}

/** 按视觉行生成行号栏文本：续行用空串占位 */
export function buildGutterText(rows: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    out.push(String(i + 1));
    for (let r = 1; r < rows[i]; r++) out.push('');
  }
  return out.join('\n');
}
