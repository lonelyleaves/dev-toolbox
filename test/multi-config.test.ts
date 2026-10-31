/**
 * 多连接配置改造 —— 端到端自验证。
 * 覆盖"用户会真实碰到"的行为：旧单配置迁移、多配置读写、凭据/缓存按配置隔离、
 * 指纹按 configId、项目栏摘要计数；并对源码做静态契约核查（configId 是否贯通到宿主/桥接层）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectStore, projectSecretKey, configHashOf, cacheSlot } from '../src/host/project-store';
import { normalizeConnections, findDbConfig, findKingdeeConfig, emptyProjectConfig, type ProjectConfig } from '../src/core/messaging';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-mc-'));
  return { dir, store: new ProjectStore({ fsPath: dir } as any) };
}
const cfgPath = (dir: string, id: string) => path.join(dir, 'projects', id, 'config.json');

describe('① 旧单配置 → 数组无损迁移', () => {
  it('磁盘上是旧单对象 config.json，loadConfig 读出为数组且 id=default', () => {
    const { dir, store } = makeStore();
    const p = store.create('老项目');
    // 直接写一份"旧格式"文件，模拟升级前留下的数据
    fs.writeFileSync(cfgPath(dir, p.id), JSON.stringify({
      connections: {
        db: { client: 'mysql', host: 'legacy-host', port: 3306, user: 'root', database: 'legacy_db' },
        kingdee: { baseUrl: 'http://legacy/k3', dbId: 'L001' },
      },
    }), 'utf8');
    const cfg = store.loadConfig(p.id);
    expect(Array.isArray(cfg.connections.db)).toBe(true);
    expect(cfg.connections.db![0].id).toBe('default');
    expect(cfg.connections.db![0].host).toBe('legacy-host');
    expect(cfg.connections.kingdee![0].id).toBe('default');
    expect(cfg.connections.kingdee![0].baseUrl).toBe('http://legacy/k3');
  });

  it('normalizeConnections 对空/缺字段容错（不报错，产出空数组）', () => {
    expect(normalizeConnections(undefined).connections.db).toEqual([]);
    expect(normalizeConnections({}).connections.kingdee).toEqual([]);
    expect(normalizeConnections({ connections: { db: {} } }).connections.db).toEqual([]); // 空对象不算一条
  });

  it('数据库配置按主机自动命名：旧名 127.0.0.1 会被改成当前主机', () => {
    const cfg = normalizeConnections({
      connections: { db: [{ id: 'd1', name: '127.0.0.1', host: '10.0.3.60', database: 'AIS2026test', client: 'mssql' }] },
    });
    const db = cfg.connections.db![0];
    expect(db.name).toBe('10.0.3.60');
    expect(db.autoName).toBe(true);
  });

  it('用户自定义名称不会被自动改名', () => {
    const cfg = normalizeConnections({
      connections: { db: [{ id: 'd1', name: '生产库', host: '10.0.3.60', database: 'AIS2026test' }] },
    });
    const db = cfg.connections.db![0];
    expect(db.name).toBe('生产库');
    expect(db.autoName).toBe(false);
  });
});

describe('② 凭据按项目+配置隔离（default 命中旧 key）', () => {
  it('default/缺省 → 旧格式 key；新配置 → 拼 configId', () => {
    expect(projectSecretKey('p1', 'db')).toBe('devtoolbox.project.p1.db');
    expect(projectSecretKey('p1', 'db', 'default')).toBe('devtoolbox.project.p1.db');
    expect(projectSecretKey('p1', 'db', 'c_new')).toBe('devtoolbox.project.p1.db.c_new');
    expect(projectSecretKey('p1', 'kingdee', 'c_new')).toBe('devtoolbox.project.p1.kingdee.c_new');
    // 两条新配置互不相同
    expect(projectSecretKey('p1', 'db', 'a')).not.toBe(projectSecretKey('p1', 'db', 'b'));
  });
});

describe('③ 缓存按 configId 分槽，多库互不覆盖', () => {
  const seed = () => ({ version: 1 as const, name: 'd', dialect: 'mysql' as const, tables: [], importErrors: [] });

  it('default 用旧文件名；非 default 拼 __configId', () => {
    const { dir, store } = makeStore();
    const p = store.create('缓存');
    store.saveCache(p.id, 'db', seed() as any, { kind: 'db', importedAt: 'x', configHash: 'h1' }, 'default');
    store.saveCache(p.id, 'db', seed() as any, { kind: 'db', importedAt: 'y', configHash: 'h2' }, 'd2');
    const cacheDir = path.join(dir, 'projects', p.id, 'cache');
    expect(fs.existsSync(path.join(cacheDir, 'db.json'))).toBe(true);      // 旧槽
    expect(fs.existsSync(path.join(cacheDir, 'db__d2.json'))).toBe(true);  // 新槽
    expect(store.loadCache(p.id, 'db', 'default')!.meta.importedAt).toBe('x');
    expect(store.loadCache(p.id, 'db', 'd2')!.meta.importedAt).toBe('y');
    // 清一条不影响另一条
    store.clearCache(p.id, 'db', 'd2');
    expect(store.loadCache(p.id, 'db', 'd2')).toBeNull();
    expect(store.loadCache(p.id, 'db', 'default')).toBeTruthy();
  });

  it('cacheSlot 纯函数：default/缺省=kind，其余=kind__id', () => {
    expect(cacheSlot('kingdee')).toBe('kingdee');
    expect(cacheSlot('kingdee', 'default')).toBe('kingdee');
    expect(cacheSlot('kingdee', 'k9')).toBe('kingdee__k9');
  });
});

describe('④ 指纹按 configId + 项目栏摘要计数', () => {
  it('两条不同 db 配置各自指纹不同；缺省取首条', () => {
    const cfg: ProjectConfig = { connections: { db: [
      { id: 'd1', name: 'a', client: 'mysql', host: 'h1', database: 'x' },
      { id: 'd2', name: 'b', client: 'mysql', host: 'h2', database: 'y' },
    ] } };
    expect(configHashOf(cfg, 'db', 'd1')).not.toBe(configHashOf(cfg, 'db', 'd2'));
    expect(configHashOf(cfg, 'db')).toBe(configHashOf(cfg, 'db', 'd1')); // 缺省=首条
    expect(configHashOf(cfg, 'db', 'nope')).toBe(configHashOf(cfg, 'db', 'd1')); // 找不到回落首条
    expect(configHashOf(undefined, 'db')).toBe('');
  });

  it('list() 的 configSummary 是"配了几条"，不是布尔', () => {
    const { store } = makeStore();
    const p = store.create('计数');
    store.saveConfig(p.id, { connections: {
      db: [
        { id: 'd1', name: 'ok', host: 'h1', database: 'x' },        // 完整 → 计入
        { id: 'd2', name: 'partial', host: 'h2' },                   // 缺 database → 不计
      ],
      kingdee: [{ id: 'k1', name: 'k', baseUrl: 'http://k3' }],
    } } as any);
    const meta = store.list().projects.find((x) => x.id === p.id);
    expect(meta?.configSummary?.db).toBe(1);
    expect(meta?.configSummary?.kingdee).toBe(1);
  });
});

describe('⑤ findDbConfig / findKingdeeConfig 回落语义', () => {
  const cfg: ProjectConfig = { connections: {
    db: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] as any,
    kingdee: [{ id: 'k1', name: 'K', baseUrl: 'u' }] as any,
  } };
  it('按 id 命中；缺省/未命中回落首条；空返回 undefined', () => {
    expect(findDbConfig(cfg, 'b')?.name).toBe('B');
    expect(findDbConfig(cfg)?.id).toBe('a');
    expect(findDbConfig(cfg, 'zzz')?.id).toBe('a');
    expect(findDbConfig(emptyProjectConfig())).toBeUndefined();
    expect(findKingdeeConfig(cfg, 'k1')?.baseUrl).toBe('u');
  });
});

describe('⑥ 源码静态契约：configId 是否贯通各层', () => {
  const ROOT = path.resolve(__dirname, '..');
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const bridge = read('src/webview/bridge.ts');
  const dispatch = read('src/host/dispatcher.ts');
  const page = read('src/webview/pages/DictionaryPage.tsx');
  const panels = read('src/webview/pages/dictionary/panels.tsx');

  it('bridge 的同步/凭据/金蝶方法都带 configId 形参', () => {
    expect(bridge).toContain("projectSync: (projectId: string, kind: 'db' | 'kingdee', configId?: string");
    expect(bridge).toContain("values: Record<string, string>, configId?: string");
    expect(bridge).toContain('opts?: { projectId?: string; configId?: string');
    expect(bridge).toContain('kingdeeTestConfig: (projectId: string, configId?: string)');
  });

  it('dispatcher 用 findDbConfig/findKingdeeConfig 取配置（不再当单对象）', () => {
    expect(dispatch).toContain('findDbConfig(cfg, configId)');
    expect(dispatch).toContain('findKingdeeConfig(cfg, configId)');
    expect(dispatch).toContain('projectSecretKey(projectId, kind, configId)');
  });

  it('RepairPanel 基线数据库扩到 4 种，且 JSON 有粘贴模式', () => {
    expect(page).toContain("id: 'postgres'");
    expect(page).toContain("id: 'oracle'");
    expect(page).toContain('粘贴 JSON');
    expect(page).toContain('parseJsonText');
  });

  it('ProjectConfigPanel 是多配置列表（新增/删除/选中），且透传 configId', () => {
    expect(panels).toContain('addDb');
    expect(panels).toContain('delKd');
    expect(panels).toContain('projectReadSecretExists(p.projectId!, \'db\', d.id)');
  });

  it('回归护栏：全仓不再有把 connections.db/kingdee 当单对象取字段的写法', () => {
    const files = ['src/webview/pages/DictionaryPage.tsx', 'src/webview/pages/dictionary/panels.tsx', 'src/host/dispatcher.ts', 'src/host/project-store.ts'];
    const bad = /connections\??\.(db|kingdee)\??\.(host|client|port|user|database|baseUrl|dbId|appId|argStyle|loginPath|metadataPath|lcid)\b/;
    for (const f of files) expect(bad.test(read(f)), f).toBe(false);
  });
});
