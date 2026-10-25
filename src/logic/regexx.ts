export interface RegexMatch {
  index: number;
  text: string;
  groups: { name?: string; index?: number; text: string | undefined }[];
}

export function runRegex(pattern: string, flags: string, subject: string): { matches: RegexMatch[]; error?: string } {
  if (!pattern) return { matches: [] };
  try {
    const re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
    const matches: RegexMatch[] = [];
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(subject)) !== null && guard++ < 5000) {
      if (m[0] === '') { re.lastIndex++; continue; } // 防空转
      const groupNames = (re as any).groups ? Object.keys((re as any).groups) : [];
      matches.push({
        index: m.index,
        text: m[0],
        groups: m.slice(1).map((g, i) => ({
          name: m!.groups ? Object.keys(m!.groups)[i] : (groupNames[i] || undefined),
          index: g === undefined ? undefined : m!.index + m![0].indexOf(g),
          text: g,
        })),
      });
    }
    return { matches };
  } catch (e: any) {
    return { matches: [], error: e?.message || String(e) };
  }
}

export const REGEX_LIBRARY: { name: string; pattern: string; desc: string }[] = [
  { name: '手机号(中国内地)', pattern: '1[3-9]\\d{9}', desc: '11 位，1 开头，第二位 3-9' },
  { name: '身份证号', pattern: '[1-9]\\d{5}(18|19|20)\\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx]', desc: '18 位，含出生日期与校验位' },
  { name: '邮箱', pattern: '[\\w.%+-]+@[\\w-]+(\\.[\\w-]+)+', desc: '常见邮箱格式' },
  { name: 'URL', pattern: 'https?://[\\w\\-?=%#/.,@:&+~]+', desc: 'http/https 链接' },
  { name: 'IPv4', pattern: '((25[0-5]|2[0-4]\\d|[01]?\\d?\\d)\\.){3}(25[0-5]|2[0-4]\\d|[01]?\\d?\\d)', desc: '0-255 四段' },
  { name: 'IPv6(简版)', pattern: '([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}', desc: '8 组十六进制' },
  { name: '日期 yyyy-MM-dd', pattern: '\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])', desc: '严格月份日期' },
  { name: '时间 HH:mm:ss', pattern: '([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d', desc: '24 小时制' },
  { name: '中文字符', pattern: '[\\u4e00-\\u9fa5]+', desc: '连续中文' },
  { name: '邮政编码', pattern: '[1-9]\\d{5}(?!\\d)', desc: '6 位非 0 开头' },
  { name: '强密码', pattern: '(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)[\\w!@#$%^&*]{8,}', desc: '至少 8 位，含大小写与数字' },
  { name: 'HTML 标签', pattern: '<([a-zA-Z][\\w-]*)([^>]*)>([\\s\\S]*?)<\\/\\1>', desc: '配对标签，反向引用' },
];

/** 分段解释正则含义 */
type ExplainFn = (m: RegExpExecArray) => string;
type ExplainRule = [RegExp, string | ExplainFn | Record<string, string>];

export function explainRegex(pattern: string): { token: string; meaning: string }[] {
  const out: { token: string; meaning: string }[] = [];
  const dict: ExplainRule[] = [
    [/^\(\?<[a-zA-Z_$][\w$]*>/, '命名捕获分组开始'],
    [/^\(\?:/, '非捕获分组开始'],
    [/^\(\?<[!=]/, '前瞻断言开始'],
    [/^\(\?</, '命名分组开始'],
    [/^\(/, '分组开始'],
    [/^\)/, '分组结束'],
    [/^\|/, '或：左右两侧任一匹配'],
    [/^\\[dDwWsSbB]/, (m) => ({
      '\\d': '数字 0-9', '\\D': '非数字', '\\w': '单词字符 a-z A-Z 0-9 _',
      '\\W': '非单词字符', '\\s': '空白字符', '\\S': '非空白字符',
      '\\b': '单词边界', '\\B': '非单词边界',
    }[m[0]] || '转义'),],
    [/^\\u[0-9a-fA-F]{4}/, 'Unicode 转义'],
    [/^\\x[0-9a-fA-F]{2}/, '十六进制转义'],
    [/^\\./, '转义字符（字面量）'],
    [/^\^/, '行/串开头'],
    [/^\$/, '行/串结尾'],
    [/^\.[*+?]\?/, '任意字符重复（非贪婪）'],
    [/^\.\*\??/, '任意字符任意次'],
    [/^\.\+\??/, '任意字符 1 次或多次'],
    [/^\./, '任意单个字符'],
    [/^\[(\^)?\]/, '空字符类'],
    [/^\[(\^)?/, (m) => (m[1] ? '否定字符类开始 [^' : '字符类开始 [')],
    [/^\]/, '字符类结束'],
    [/^\{\d+,\d+\}\?/, (m) => `前项 ${m[0].slice(1, -2).replace(',', ' 到 ')} 次（非贪婪）`],
    [/^\{\d+,\d+\}/, (m) => `前项 ${m[0].slice(1, -1).replace(',', ' 到 ')} 次`],
    [/^\{\d+,\}\?/, (m) => `前项至少 ${m[0].slice(1, -2)} 次（非贪婪）`],
    [/^\{\d+,\}/, (m) => `前项至少 ${m[0].slice(1, -1)} 次`],
    [/^\{\d+\}\?/, (m) => `前项恰好 ${m[0].slice(1, -2)} 次（非贪婪）`],
    [/^\{\d+\}/, (m) => `前项恰好 ${m[0].slice(1, -1)} 次`],
    [/^([*+?])\?/, (m) => `${({ '*': '前项 0 次或多次', '+': '前项 1 次或多次', '?': '前项 0 或 1 次' } as Record<string, string>)[m[1]]}（非贪婪）`],
    [/^[*+?]/, (m) => ({ '*': '前项 0 次或多次', '+': '前项 1 次或多次', '?': '前项 0 或 1 次' } as Record<string, string>)[m[0]]],
    [/^[\u4e00-\u9fa5]+/, '中文字面文本'],
    [/^[A-Za-z0-9_@$%\-#/:=,; ]+/, '字面文本'],
  ];
  let rest = pattern;
  let guard = 0;
  while (rest.length && guard++ < 500) {
    let matched = false;
    for (const [re, fn] of dict) {
      const m = re.exec(rest);
      if (m) {
        const meaning =
          typeof fn === 'function' ? fn(m)
            : typeof fn === 'string' ? fn
              : fn[m[0]] || '量词';
        out.push({ token: m[0], meaning });
        rest = rest.slice(m[0].length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      out.push({ token: rest[0], meaning: '字面字符' });
      rest = rest.slice(1);
    }
  }
  return out;
}
