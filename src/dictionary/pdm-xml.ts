/**
 * PDM/XML 轻量扫描器。
 *
 * 为什么不用 fast-xml-parser：实测 85MB 的金蝶全库 PDM，fast-xml-parser 的 parseXml
 * 要 400~650 秒（CPU profile 显示 12.3s/14.8s 都在它身上），而本扫描器同等规模约数秒。
 * 它内部对整份文本反复切片 + 正则匹配，规模上去后严重退化；这里改成单遍 indexOf 扫描，
 * 只做"标签切分 + 属性解析 + 文本收集"，不建多余的中间结构。
 *
 * 输出形状刻意与 fast-xml-parser（attributeNamePrefix:'@_'）保持一致，parsePdm 无需改动：
 *   - 属性 → '@_Id' / '@_Ref'
 *   - 子元素 → 以标签名为 key，重复出现时为数组
 *   - 纯文本叶子 → 直接是字符串
 *   - 同时有属性和文本 → { '@_x': v, '#text': '...' }
 *   - 空元素 <a/> 或 <a></a>（无属性无子节点） → ''
 */
const QUOTE_DQ = 34;   // "
const QUOTE_SQ = 39;   // '
const GT = 62;         // >
const LT = 60;         // <
const SLASH = 47;      // /

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/** 解码 XML 实体（PDM 里常见 &amp; &lt; &gt; 与数字引用） */
export function decodeXmlEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.charCodeAt(0) === 35) { // &#...;
      const isHex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88;
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body] ?? m;
  });
}

interface Slot { parent: any; key: string | number; }

function addChild(parent: any, tag: string, node: any): Slot {
  const cur = parent[tag];
  if (cur === undefined) {
    parent[tag] = node;
    return { parent, key: tag };
  }
  if (Array.isArray(cur)) {
    cur.push(node);
    return { parent: cur, key: cur.length - 1 };
  }
  const arr = [cur, node];
  parent[tag] = arr;
  return { parent: arr, key: 1 };
}

function setText(node: any, text: string) {
  const prev = node['#text'];
  node['#text'] = prev === undefined ? text : prev + text;
}

/** 解析标签里的属性：只支持 name="value" / name='value'（PDM 只用这两种） */
function parseAttrs(body: string, from: number, node: any) {
  let i = from;
  const n = body.length;
  while (i < n) {
    // 跳过空白
    while (i < n && (body.charCodeAt(i) === 32 || body.charCodeAt(i) === 10 || body.charCodeAt(i) === 13 || body.charCodeAt(i) === 9)) i++;
    if (i >= n) break;
    // 属性名
    const start = i;
    while (i < n && body.charCodeAt(i) !== 61) i++; // '='
    if (i >= n) break;
    const name = body.slice(start, i);
    i++; // 跳过 =
    // 值（带引号）
    let quote = 0;
    while (i < n) {
      const c = body.charCodeAt(i);
      if (c === 34 || c === 39) { quote = c; break; }
      if (c === 32 || c === 10 || c === 13 || c === 9) break;
      i++;
    }
    if (!quote) { // 无引号值（不规范但兼容）
      const vs = i;
      while (i < n && body.charCodeAt(i) !== 32 && body.charCodeAt(i) !== 10 && body.charCodeAt(i) !== 13 && body.charCodeAt(i) !== 9) i++;
      node['@_' + name] = decodeXmlEntities(body.slice(vs, i));
      continue;
    }
    i++;
    const vs = i;
    while (i < n && body.charCodeAt(i) !== quote) i++;
    node['@_' + name] = decodeXmlEntities(body.slice(vs, i));
    i++; // 跳过收尾引号
  }
}

/**
 * 单遍扫描构建轻量树。入参应为完整 XML 文本；解析失败抛错，由调用方记录 importErrors。
 */
export function parseXmlLight(xml: string): any {
  const root: any = {};
  const slots: Slot[] = [];
  const nodes: any[] = [root];
  const n = xml.length;
  let i = 0;
  let rootTagDone = false;

  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;

    // 标签之间的文本
    if (lt > i) {
      const raw = xml.slice(i, lt);
      const text = raw.trim();
      if (text) setText(nodes[nodes.length - 1], decodeXmlEntities(text));
    }

    const c1 = xml.charCodeAt(lt + 1);

    // 注释 <!-- -->
    if (c1 === 33 && xml.startsWith('!--', lt + 1)) {
      const e = xml.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    // PI <? ?> / XML 声明
    if (c1 === 63) {
      const e = xml.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    // CDATA
    if (c1 === 33 && xml.startsWith('![CDATA[', lt + 1)) {
      const e = xml.indexOf(']]>', lt + 9);
      const raw = xml.slice(lt + 9, e < 0 ? n : e);
      setText(nodes[nodes.length - 1], raw);
      i = e < 0 ? n : e + 3;
      continue;
    }
    // DOCTYPE 等声明：可能内含 [ ... ]，需要括号配平
    if (c1 === 33) {
      let j = lt + 2;
      let depth = 0;
      while (j < n) {
        const ch = xml.charCodeAt(j);
        if (ch === 91) depth++;
        else if (ch === 93) depth--;
        else if (ch === GT && depth <= 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }

    // 闭合标签 </tag>
    if (c1 === SLASH) {
      const gt = xml.indexOf('>', lt + 2);
      if (gt < 0) break;
      if (nodes.length > 1) {
        const node = nodes.pop()!;
        const slot = slots.pop()!;
        finalize(slot, node);
      }
      i = gt + 1;
      continue;
    }

    // 开标签：找到真正的 '>'（引号内的 > 不算）
    let j = lt + 1;
    let quote = 0;
    while (j < n) {
      const ch = xml.charCodeAt(j);
      if (quote) {
        if (ch === quote) quote = 0;
      } else if (ch === QUOTE_DQ || ch === QUOTE_SQ) {
        quote = ch;
      } else if (ch === GT) {
        break;
      }
      j++;
    }
    const seg = xml.slice(lt + 1, j);
    const selfClosing = seg.charCodeAt(seg.length - 1) === SLASH;
    const body = selfClosing ? seg.slice(0, -1) : seg;

    // 标签名与属性分界
    let sp = 0;
    while (sp < body.length) {
      const ch = body.charCodeAt(sp);
      if (ch === 32 || ch === 10 || ch === 13 || ch === 9) break;
      sp++;
    }
    const tag = sp === 0 ? body : body.slice(0, sp);
    const node: any = {};
    if (sp < body.length) parseAttrs(body, sp, node);

    // 无属性的自闭合元素直接写成空串，与 fast-xml-parser 一致（<b:X/> → ''）
    const value = selfClosing && Object.keys(node).length === 0 ? '' : node;
    if (!rootTagDone) {
      // 根元素：挂在 root 对象下，与 fast-xml-parser 的返回形状一致
      rootTagDone = true;
      addChild(root, tag, value);
      if (!selfClosing) { slots.push({ parent: root, key: tag }); nodes.push(node); }
    } else {
      const parent = nodes[nodes.length - 1];
      const slot = addChild(parent, tag, value);
      if (!selfClosing) { slots.push(slot); nodes.push(node); }
    }
    i = j + 1;
  }

  // 未闭合的空节点（容错）
  while (nodes.length > 1) {
    const node = nodes.pop()!;
    finalize(slots.pop()!, node);
  }
  return root;
}

/** 元素结束：纯文本叶子直接收敛成字符串 */
function finalize(slot: Slot, node: any) {
  const keys = Object.keys(node);
  const hasText = node['#text'] !== undefined;
  const onlyText = hasText && keys.length === 1;
  if (onlyText) {
    slot.parent[slot.key] = node['#text'];
    return;
  }
  if (keys.length === 0) {
    slot.parent[slot.key] = '';
  }
}
