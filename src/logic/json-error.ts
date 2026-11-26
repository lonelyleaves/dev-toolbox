/**
 * JSON 解析错误的中文化定位。
 *
 * V8 的原始报文（如 `Expected property name or '}' in JSON at position 1`）
 * 对中文用户几乎没用：位置只给字符偏移、不给上下文，也不说明为什么失败。
 * 这里统一转成「位置 + 原因 + 片段 + 排查建议」。
 */

export interface JsonErrorInfo {
  /** 原始英文报文，保留给需要细节的人 */
  raw: string;
  /** 一句话标题：第几行第几列 + 原因 */
  title: string;
  /** 失败原因（不含位置） */
  reason: string;
  /** 出错字符偏移（0-based） */
  position?: number;
  line?: number;
  column?: number;
  /** 出错处上下文片段 */
  snippet?: string;
  /** 与 snippet 对齐的指示行 */
  caret?: string;
  /** 排查建议 */
  hint?: string;
  /** 是否已经尝试过自动修复仍失败 */
  repaired?: boolean;
}

/** 由 line/column 反推字符偏移 */
function offsetOf(source: string, line: number, column: number): number {
  let idx = 0;
  let curLine = 0;
  while (curLine < line && idx < source.length) {
    if (source[idx] === '\n') curLine++;
    idx++;
  }
  return Math.min(source.length, idx + column);
}

function lineColumnOf(source: string, position: number): { line: number; column: number } {
  const cut = Math.max(0, Math.min(position, source.length));
  const before = source.slice(0, cut);
  const line = (before.match(/\n/g) || []).length;
  const lastNl = before.lastIndexOf('\n');
  return { line, column: cut - lastNl - 1 };
}

function extractPosition(msg: string, source: string): { position?: number; line?: number; column?: number } {
  const mPos = /position (\d+)/i.exec(msg);
  const mLC = /line (\d+) column (\d+)/i.exec(msg);
  let position: number | undefined;
  let line: number | undefined;
  let column: number | undefined;

  if (mLC) {
    line = Number(mLC[1]) - 1;
    column = Number(mLC[2]) - 1;
  }
  if (mPos) {
    position = Number(mPos[1]);
    if (line === undefined || column === undefined) {
      const lc = lineColumnOf(source, position);
      line = lc.line;
      column = lc.column;
    }
  } else if (line !== undefined && column !== undefined) {
    position = offsetOf(source, line, column);
  }
  return { position, line, column };
}

/** 原因 + 建议：按报文关键词归类，尽量给可操作的下一步 */
function classify(msg: string, at: string, source: string, position?: number, trailingContent = false): { reason: string; hint: string } {
  const lower = msg.toLowerCase();
  const around = position !== undefined ? source.slice(Math.max(0, position - 1), position + 1) : '';

  if (/end of (the )?json input/.test(lower)) {
    return {
      reason: '内容不完整，括号没有闭合',
      hint: '多半是被截断（复制不全 / 超长粘贴丢失尾部）。检查最外层 {} 或 [] 是否都有对应的闭合符号。',
    };
  }
  if (/after json/.test(lower) || trailingContent) {
    return {
      reason: 'JSON 结束后还有多余内容',
      hint: '像是把两段 JSON（或日志 + JSON）拼在了一起；只保留一份，或合并成一个数组。',
    };
  }
  if (/bad escaped character/.test(lower)) {
    return {
      reason: '字符串里有非法转义',
      hint: "JSON 只支持 \\\" \\\\ \\/ \\b \\f \\n \\r \\t \\uXXXX；Python 的 \\' 需要改成 '。",
    };
  }
  // Node 18 / 部分内核只会说 Unexpected string|number|boolean，不报缺逗号
  const terse = /unexpected (string|number|boolean)/.exec(lower);
  if (terse) {
    const kind = terse[1] === 'string' ? '字符串' : terse[1] === 'number' ? '数字' : '布尔值';
    return {
      reason: `这里多了一个${kind}（通常是漏了逗号）`,
      hint: '检查该位置前一项末尾是否缺逗号，或前一个引号没闭合导致解析错位。',
    };
  }
  if (/property name/.test(lower) || /double-quoted/.test(lower)) {
    if (at === "'" || around.includes("'")) {
      return {
        reason: '键名必须用双引号（这里像是单引号）',
        hint: "单引号键名常见于 Python 字典；可点「美化」让工具尝试自动转换，或把 ' 换成 \"。",
      };
    }
    return {
      reason: '这里需要一个 "键名": 或 }',
      hint: '常见原因是上一项漏了逗号、多了一个冒号，或数组 [ ] 里写了键值对。',
    };
  }
  if (/,|\]/.test(msg) && /expected ','/.test(lower)) {
    return {
      reason: '缺少逗号或括号提前闭合',
      hint: '检查该位置前一行末尾是否漏了逗号。',
    };
  }
  if (/unexpected token/.test(lower)) {
    if (at === ':') {
      return {
        reason: '这里不该出现冒号',
        hint: '数组里不能写 `键: 值`；如果本意是对象，把外层的 [ ] 换成 { }。',
      };
    }
    if (at === "'" || /'/.test(around)) {
      return {
        reason: `出现无法解析的字符 ${at || '(空白)'}`,
        hint: "单引号 / 中文引号 / 全角冒号都会导致解析失败；工具已尝试自动修复仍失败，请检查该位置附近。",
      };
    }
    if (/^["a-z]$/i.test(at) && /['"]?[a-z]['"]?\s*['"]?[a-z]/i.test(around)) {
      return {
        reason: `出现无法解析的字符 ${at || '(空白)'}`,
        hint: '两个值之间漏了逗号，或引号没有配对。',
      };
    }
    return {
      reason: `出现无法解析的字符 ${at || '(空白)'}`,
      hint: '检查该位置前后：是否漏了逗号、引号是否成对、括号是否闭合。',
    };
  }
  return {
    reason: 'JSON 语法错误',
    hint: '检查该位置附近是否缺逗号、引号不配对或括号未闭合。',
  };
}

export function describeJsonError(err: unknown, source: string, opts: { repaired?: boolean } = {}): JsonErrorInfo {
  const raw = String((err as any)?.message || err || 'JSON 解析失败');
  const text = String(source || '');
  const { position, line, column } = extractPosition(raw, text);

  // "Unexpected token 'x' in JSON..." 里的 token 也拿来判断
  const tokenMatch = /unexpected token '?(.)'?/i.exec(raw);
  const at = position !== undefined && position < text.length
    ? text[position]
    : tokenMatch?.[1] ?? '';

  // 前半段能单独解析 → 出错点其实是“第二个 JSON 的开头”
  let trailingContent = false;
  if (position !== undefined && position > 0 && position < text.length) {
    try {
      JSON.parse(text.slice(0, position));
      trailingContent = true;
    } catch { /* 不是拼接场景 */ }
  }

  const { reason, hint } = classify(raw, at, text, position, trailingContent);
  const where = line !== undefined && column !== undefined
    ? `第 ${line + 1} 行第 ${column + 1} 列`
    : position !== undefined ? `第 ${position + 1} 个字符` : '';

  let snippet: string | undefined;
  let caret: string | undefined;
  if (position !== undefined && text.length > 0) {
    const from = Math.max(0, position - 36);
    const to = Math.min(text.length, position + 36);
    const oneLine = (s: string) => s.replace(/\n/g, '\\n');
    const prefix = from > 0 ? '…' : '';
    snippet = prefix + oneLine(text.slice(from, to));
    caret = ' '.repeat(Math.min(36 + prefix.length, snippet.length - 1)) + '^';
  }

  return {
    raw,
    title: `${where ? where + '：' : ''}${reason}${opts.repaired ? '（已尝试自动修复）' : ''}`,
    reason,
    position,
    line,
    column,
    snippet,
    caret,
    hint,
    repaired: !!opts.repaired,
  };
}
