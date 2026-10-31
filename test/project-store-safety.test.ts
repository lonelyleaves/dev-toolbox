import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectStore } from '../src/host/project-store';
import { emptyDictionary } from '../src/dictionary/model';

describe('项目库持久化安全', () => {
  let dir: string;
  let store: ProjectStore;
  let root: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtstore-'));
    store = new ProjectStore({ fsPath: dir } as any);
    root = path.join(dir, 'projects');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('index.json 损坏时从 index.bak 恢复，不静默清空项目列表', () => {
    store.create('A');
    store.create('B');
    fs.copyFileSync(path.join(root, 'index.json'), path.join(root, 'index.bak'));
    fs.writeFileSync(path.join(root, 'index.json'), '{"version":1,"projects":', 'utf8');

    const list = store.list();
    expect(list.projects.map((p) => p.name)).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('index 与备份都损坏时抛错，而不是返回空列表', () => {
    store.create('A');
    fs.writeFileSync(path.join(root, 'index.json'), 'broken', 'utf8');
    fs.writeFileSync(path.join(root, 'index.bak'), 'broken', 'utf8');

    expect(() => store.list()).toThrow(/项目索引损坏/);
  });

  it('拒绝路径穿越项目 id', () => {
    expect(() => store.load('../evil')).toThrow(/非法项目 id/);
    expect(() => store.save('../evil', emptyDictionary('x'))).toThrow(/非法项目 id/);
  });

  it('字典写入为原子替换，不残留临时文件', () => {
    const p = store.create('A');
    store.save(p.id, emptyDictionary('A'));

    const files = fs.readdirSync(path.join(root, p.id));
    expect(files.some((f) => f.includes('.tmp-'))).toBe(false);
    expect(store.load(p.id)?.name).toBe('A');
  });

  it('保存不存在的项目直接报错，不在磁盘留下孤儿目录', () => {
    expect(() => store.save('p_missing', emptyDictionary('x'))).toThrow(/项目不存在/);
    expect(fs.existsSync(path.join(root, 'p_missing'))).toBe(false);
  });
});
