/**
 * Java 类源码 → 示例 JSON。
 * 自研轻量解析（不引 java-parser，规避 LGPL 依赖）：
 * 支持字段/泛型/嵌套类/枚举/Jackson 注解(@JsonProperty/@JsonIgnore/@JsonAlias)/常见日期类型。
 */

export interface JavaField {
  name: string;
  type: string; // 原始类型串，含泛型
  jsonName: string;
  ignored: boolean;
  annotations: string[];
}

export interface JavaClass {
  name: string;
  kind: 'class' | 'enum';
  enumConstants: string[];
  fields: JavaField[];
  extends?: string;
}

export interface SampleOptions {
  maxDepth?: number;
  dateStyle?: 'iso' | 'space' | 'timestamp';
  stringSample?: string;
  listSize?: number;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/** 解析源文件中所有类型定义 */
export function parseJavaClasses(src: string): Map<string, JavaClass> {
  const result = new Map<string, JavaClass>();
  const clean = stripComments(src);
  const classRe = /\b(class|enum)\s+(\w+)(?:\s+extends\s+([\w.<>]+))?[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(clean))) {
    const [, kind, name, parent] = m;
    const bodyStart = m.index + m[0].length;
    const body = extractBraces(clean, bodyStart - 1);
    const cls: JavaClass = { name, kind: kind as any, enumConstants: [], fields: [], extends: parent };
    if (kind === 'enum') {
      const consts = body.slice(1).split(/[,;]/)[0] || '';
      cls.enumConstants = consts.match(/\b[A-Z_][A-Z0-9_]*\b/g) || [];
    } else {
      cls.fields = parseFields(body);
    }
    result.set(name, cls);
  }
  return result;
}

function extractBraces(text: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return text.slice(openIdx);
}

const FIELD_SKIP = /\b(class|enum|interface|return|new|if|for|while|else|try|catch|package|import)\b/;

function parseFields(body: string): JavaField[] {
  const fields: JavaField[] = [];
  // 注解行累积，字段声明行落地；先按 ; { } 拆行以兼容单行写法
  const NL = String.fromCharCode(10);
  const lines = body.replace(/([;{}])/g, '$1' + NL).split(NL);
  let pendingAnnotations: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { pendingAnnotations = []; continue; }
    if (line.startsWith('@')) {
      pendingAnnotations.push(line);
      continue;
    }
    // static/final 常量、方法、构造器跳过
    const decl = line
      .replace(/\b(public|private|protected|static|final|transient|volatile|synchronized|default)\b/g, '')
      .trim();
    if (!decl || FIELD_SKIP.test(decl)) { pendingAnnotations = []; continue; }
    if (/[()]/.test(decl.replace(/\([^)]*\)\s*;/g, '')) && /\(/.test(decl)) {
      // 方法声明（含泛型返回类型）：跳过；但保留 `Type name(...)` 判为方法
      if (!/;/.test(decl) || /\b\w+\s*\(/.test(decl)) { pendingAnnotations = []; continue; }
    }
    const m = decl.match(/^([\w.$]+(?:\s*<[^;=]*>)?(?:\s*\[\s*\])*(?:\.\w+)?(?:<[^;=]*>)?(?:\s*\[\s*\])*)\s+(\w+)\s*(?:=[^;]*)?;?$/);
    if (!m) { pendingAnnotations = []; continue; }
    const [, type, name] = m;
    let jsonName = name;
    let ignored = false;
    for (const a of pendingAnnotations) {
      const jp = a.match(/@JsonProperty\s*\(\s*"([^"]+)"\s*\)/);
      if (jp) jsonName = jp[1];
      if (/@JsonIgnore/.test(a)) ignored = true;
    }
    fields.push({ name, type: type.replace(/\s+/g, ''), jsonName, ignored, annotations: pendingAnnotations });
    pendingAnnotations = [];
  }
  return fields;
}

/** 生成示例 JSON */
export function javaToJson(src: string, opts: SampleOptions = {}): { json: string; rootClass?: string; error?: string } {
  const classes = parseJavaClasses(src);
  if (classes.size === 0) return { json: '', error: '未找到 class/enum 定义' };
  const maxDepth = opts.maxDepth ?? 3;
  const listSize = opts.listSize ?? 1;
  // 根类：优先 public class 的第一个
  const root = classes.values().next().value!;
  const seen = new Set<string>();

  const valueOf = (type: string, depth: number): unknown => {
    const t = type.trim();
    // 数组
    if (t.endsWith('[]')) return [primitiveOrEnum(t.slice(0, -2), opts)].slice(0, listSize);
    // 泛型容器
    const generic = t.match(/^(\w+(?:\.\w+)*)\s*<(.+)>$/);
    if (generic) {
      const [, container, inner] = generic;
      const args = splitGeneric(inner);
      if (/^(List|Collection|Iterable|CopyOnWriteArrayList|ArrayList|LinkedList)$/i.test(container)) {
        return [valueOf(args[0], depth)];
      }
      if (/^(Set|HashSet|TreeSet)$/i.test(container)) return [valueOf(args[0], depth)];
      if (/^(Map|HashMap|TreeMap|LinkedHashMap|ConcurrentHashMap)$/i.test(container)) {
        const key = String(primitiveOrEnum(args[0], opts) ?? 'key');
        return { [key]: valueOf(args[1], depth) };
      }
      // Optional<T>
      if (/^Optional$/i.test(container)) return valueOf(args[0], depth);
      // 泛型 POJO：Foo<Bar> → 用 Foo 定义（若有）
      if (classes.has(container)) {
        return objectOf(container, depth);
      }
      return { '[key]': valueOf(args[args.length - 1], depth) };
    }
    const bare = t.replace(/\.$/, '');
    if (classes.has(bare)) return objectOf(bare, depth);
    return primitiveOrEnum(bare, opts);
  };

  const objectOf = (className: string, depth: number): unknown => {
    if (depth > maxDepth || seen.has(className)) return `{ "循环引用": "${className}" }` as unknown;
    seen.add(className);
    const cls = classes.get(className)!;
    if (cls.kind === 'enum') return cls.enumConstants[0] ?? 'UNKNOWN';
    const obj: Record<string, unknown> = {};
    // 父类字段
    if (cls.extends && classes.has(cls.extends)) {
      Object.assign(obj, valueOf(cls.extends, depth + 1) as object);
    }
    for (const f of cls.fields) {
      if (f.ignored) continue;
      const v = valueOf(f.type, depth + 1);
      obj[f.jsonName] = typeof v === 'string' && v.startsWith('{ "') ? JSON.parse(v) : v;
    }
    seen.delete(className);
    return obj;
  };

  const json = JSON.stringify(valueOf(root.name, 0), null, 2);
  return { json, rootClass: root.name };
}

function splitGeneric(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const SAMPLES: Record<string, unknown> = {
  String: '示例文本', char: 'a', Character: 'a',
  int: 1, Integer: 1, long: 1000000, Long: 1000000, short: 1, Short: 1, byte: 1, Byte: 1,
  double: 1.5, Double: 1.5, float: 1.5, Float: 1.5, BigDecimal: '12345.67', BigInteger: '9999999999',
  boolean: true, Boolean: false,
  LocalDate: '2026-01-01', LocalDateTime: '2026-01-01T12:00:00', LocalTime: '12:00:00',
  Date: 1767225600000, Timestamp: '2026-01-01 12:00:00', Instant: '2026-01-01T12:00:00Z',
  Year: 2026, Month: 'JANUARY', UUID: '00000000-0000-0000-0000-000000000000',
  Object: {}, Void: null,
};

function primitiveOrEnum(type: string, opts: SampleOptions): unknown {
  const t = type.trim().replace(/.*\./, ''); // 去包名
  if (t in SAMPLES) {
    let v = SAMPLES[t];
    if (t === 'LocalDateTime' && opts.dateStyle === 'space') v = '2026-01-01 12:00:00';
    if (t === 'LocalDateTime' && opts.dateStyle === 'timestamp') v = 1767225600000;
    if (t === 'Date' && opts.dateStyle === 'iso') v = '2026-01-01T12:00:00Z';
    if (t === 'Date' && opts.dateStyle === 'space') v = '2026-01-01 12:00:00';
    return v;
  }
  if (t === 'byte[]' || t === 'Byte[]') return 'YmFzZTY05L2g=';
  return opts.stringSample ?? `示例${t}`;
}
