export interface JsonFoldRange {
  /** 可折叠区域起始行（0-based） */
  start: number;
  /** 可折叠区域结束行（0-based，含闭合括号） */
  end: number;
  /** 层级：根对象为 0，其直接子对象/数组为 1 */
  depth: number;
  /** 直接子项数量（对象 key 数或数组元素数） */
  childCount: number;
}

export interface JsonFoldModel {
  lines: string[];
  rangesByStart: Map<number, JsonFoldRange>;
  allRanges: JsonFoldRange[];
}

export interface JsonFoldRow {
  line: number;
  text: string;
  foldable: boolean;
  collapsed: boolean;
  hidden: number;
  childCount: number;
}

/**
 * 为格式化后的 JSON 计算可折叠区域。
 *
 * 只识别双引号字符串外部的 `{}` / `[]`，避免把字符串里的括号误判成结构。
 */
export function buildJsonFoldModel(text: string): JsonFoldModel {
  const lines = String(text || '').split('\n');
  const stack: { line: number; depth: number }[] = [];
  const rangesByStart = new Map<number, JsonFoldRange>();
  const allRanges: JsonFoldRange[] = [];

  let inString = false;
  let escape = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];

      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{' || ch === '[') {
        stack.push({ line: i, depth: stack.length });
        continue;
      }

      if (ch === '}' || ch === ']') {
        const open = stack.pop();
        if (!open || open.line === i) continue;
        const range: JsonFoldRange = { start: open.line, end: i, depth: open.depth, childCount: 0 };
        allRanges.push(range);
        const old = rangesByStart.get(range.start);
        // 同一行可能连续开多个括号；保留外层范围，折叠时一次隐藏完整块
        if (!old || range.end > old.end) rangesByStart.set(range.start, range);
      }
    }
  }

  // 计算每个折叠区域的直接子项数量：按缩进层级统计
  for (const range of allRanges) {
    const startLine = lines[range.start] || '';
    const startIndent = startLine.search(/\S/);
    const childIndent = startIndent + 2;
    let count = 0;
    for (let i = range.start + 1; i < range.end; i++) {
      const line = lines[i] || '';
      const indent = line.search(/\S/);
      if (indent === childIndent) {
        // 排除只包含闭合括号的行（如 `},` 或 `]`）
        const trimmed = line.trim();
        if (!(trimmed === '},' || trimmed === '}' || trimmed === '],' || trimmed === ']')) {
          count++;
        }
      }
    }
    range.childCount = count;
    const stored = rangesByStart.get(range.start);
    if (stored && stored.start === range.start && stored.end === range.end) {
      stored.childCount = count;
    }
  }

  return { lines, rangesByStart, allRanges };
}

/** 根据当前折叠状态计算实际可见行 */
export function visibleFoldRows(model: JsonFoldModel, collapsed: Set<number>): JsonFoldRow[] {
  const rows: JsonFoldRow[] = [];
  for (let i = 0; i < model.lines.length; i++) {
    const range = model.rangesByStart.get(i);
    const isCollapsed = !!range && collapsed.has(i);
    rows.push({
      line: i,
      text: model.lines[i] || '',
      foldable: !!range,
      collapsed: isCollapsed,
      hidden: isCollapsed && range ? range.end - range.start : 0,
      childCount: range?.childCount ?? 0,
    });
    if (isCollapsed && range) i = range.end;
  }
  return rows;
}

export function allFoldStarts(model: JsonFoldModel): number[] {
  return [...model.rangesByStart.keys()];
}
