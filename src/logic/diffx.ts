import { diffLines, diffWordsWithSpace, Change } from 'diff';

export interface DiffWord {
  text: string;
  changed: boolean;
}

export interface DiffLinePair {
  leftNo?: number;
  rightNo?: number;
  left?: DiffWord[];
  right?: DiffWord[];
  type: 'equal' | 'ins' | 'del' | 'mod';
}

export interface DiffOptions {
  ignoreCase?: boolean;
  ignoreWhitespace?: boolean;
}

function normalize(text: string, opts: DiffOptions): string {
  let t = text;
  if (opts.ignoreCase) t = t.toLowerCase();
  if (opts.ignoreWhitespace) t = t.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).join('\n');
  return t;
}

/** 行级配对 diff：把 Change 序列转成左右行对（删除块与新增块配对成 mod 行） */
export function buildDiffPairs(a: string, b: string, opts: DiffOptions = {}): { pairs: DiffLinePair[]; stats: { added: number; removed: number; changed: number; equal: number } } {
  const hasNorm = opts.ignoreCase || opts.ignoreWhitespace;
  const cmpA = hasNorm ? normalize(a, opts) : a;
  const cmpB = hasNorm ? normalize(b, opts) : b;
  const changes: Change[] = diffLines(cmpA, cmpB);
  const pairs: DiffLinePair[] = [];
  const stats = { added: 0, removed: 0, changed: 0, equal: 0 };
  let leftNo = 1;
  let rightNo = 1;
  let pendingDel: string[] = [];
  let pendingIns: string[] = [];

  const flush = () => {
    const n = Math.max(pendingDel.length, pendingIns.length);
    for (let i = 0; i < n; i++) {
      const l = pendingDel[i];
      const r = pendingIns[i];
      if (l !== undefined && r !== undefined) {
        const wordChanges = diffWordsWithSpace(l, r);
        const left: DiffWord[] = [];
        const right: DiffWord[] = [];
        for (const wc of wordChanges) {
          if (wc.added) right.push({ text: wc.value, changed: true });
          else if (wc.removed) left.push({ text: wc.value, changed: true });
          else { left.push({ text: wc.value, changed: false }); right.push({ text: wc.value, changed: false }); }
        }
        pairs.push({ leftNo: leftNo++, rightNo: rightNo++, left, right, type: 'mod' });
        stats.changed++;
      } else if (l !== undefined) {
        pairs.push({ leftNo: leftNo++, left: [{ text: l, changed: true }], type: 'del' });
        stats.removed++;
      } else if (r !== undefined) {
        pairs.push({ rightNo: rightNo++, right: [{ text: r, changed: true }], type: 'ins' });
        stats.added++;
      }
    }
    pendingDel = [];
    pendingIns = [];
  };

  for (const ch of changes) {
    const lines = ch.value.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (!ch.added && !ch.removed) {
      flush();
      for (const line of lines) {
        pairs.push({
          leftNo: leftNo++, rightNo: rightNo++,
          left: [{ text: line, changed: false }], right: [{ text: line, changed: false }],
          type: 'equal',
        });
        stats.equal++;
      }
    } else if (ch.removed) {
      pendingDel.push(...lines);
    } else {
      pendingIns.push(...lines);
    }
  }
  flush();
  return { pairs, stats };
}

/** 提取差异块（供"复制单个差异块"） */
export function changedBlocks(pairs: DiffLinePair[], side: 'left' | 'right'): string[] {
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const p of pairs) {
    const isChanged = p.type !== 'equal' && (side === 'left' ? p.left : p.right);
    if (isChanged) cur.push((side === 'left' ? p.left : p.right)!.map((w) => w.text).join(''));
    else if (cur.length) { blocks.push(cur); cur = []; }
  }
  if (cur.length) blocks.push(cur);
  return blocks.map((b) => b.join('\n'));
}
