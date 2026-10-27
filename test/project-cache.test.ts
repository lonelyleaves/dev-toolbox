import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectStore, projectSecretKey, configHashOf } from '../src/host/project-store';
import { emptyProjectConfig, type ProjectConfig } from '../src/core/messaging';
import { emptyDictionary, type DictionaryModel } from '../src/dictionary/model';

function seed(): DictionaryModel {
  return {
    ...emptyDictionary('cache-seed'),
    tables: [{
      name: 'T_A', code: '表A', comment: '表A',
      columns: [{ name: 'FID', type: 'int', pk: true }],
      indexes: [], foreignKeys: [], origin: { sourceId: 's1', kind: 'db' },
    }],
  };
}

describe('项目拉取结果缓存', () => {
  let dir: string;
  let store: ProjectStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtcache-'));
    store = new ProjectStore({ fsPath: dir } as any);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('保存后可完整读回（字典 + 时间 + 指纹 + 表单标识）', () => {
    const p = store.create('缓存项目');
    const d = seed();
    const meta = {
      kind: 'kingdee', importedAt: '2026-10-27T00:00:00.000Z',
      configHash: 'hABC', formIds: ['BD_MATERIAL'], tableCount: 1,
    };

    store.saveCache(p.id, 'kingdee', d, meta);
    const got = store.loadCache(p.id, 'kingdee')!;

    expect(got).toBeTruthy();
    expect(got.dict.tables[0].name).toBe('T_A');
    expect(got.meta.importedAt).toBe('2026-10-27T00:00:00.000Z');
    expect(got.meta.configHash).toBe('hABC');
    expect(got.meta.formIds).toEqual(['BD_MATERIAL']);
  });

  it('未缓存时返回 null；清缓存后也读不到', () => {
    const p = store.create('缓存项目');
    expect(store.loadCache(p.id, 'db')).toBeNull();

    store.saveCache(p.id, 'db', seed(), { kind: 'db', importedAt: new Date().toISOString(), configHash: 'h1' });
    expect(store.loadCache(p.id, 'db')).toBeTruthy();

    store.clearCache(p.id, 'db');
    expect(store.loadCache(p.id, 'db')).toBeNull();
  });

  it('按来源类型分开存：清掉 db 不影响 kingdee', () => {
    const p = store.create('缓存项目');
    store.saveCache(p.id, 'db', seed(), { kind: 'db', importedAt: new Date().toISOString(), configHash: 'h1' });
    store.saveCache(p.id, 'kingdee', seed(), { kind: 'kingdee', importedAt: new Date().toISOString(), configHash: 'h2' });

    store.clearCache(p.id, 'db');

    expect(store.loadCache(p.id, 'db')).toBeNull();
    expect(store.loadCache(p.id, 'kingdee')).toBeTruthy();
  });

  it('改了连接配置 → configHash 变化（缓存应判定过期）', () => {
    const a: ProjectConfig = { connections: { db: [{ id: 'default', name: 'd', client: 'mysql', host: '10.0.0.5', database: 'erp' }] } };
    const b: ProjectConfig = { connections: { db: [{ id: 'default', name: 'd', client: 'mysql', host: '10.0.0.9', database: 'erp' }] } };

    expect(configHashOf(a, 'db')).toBeTruthy();
    expect(configHashOf(a, 'db')).toBe(configHashOf(a, 'db'));
    expect(configHashOf(a, 'db')).not.toBe(configHashOf(b, 'db'));
  });

  it('多配置：不同 configId 的指纹不同', () => {
    const cfg: ProjectConfig = { connections: { db: [
      { id: 'd1', name: 'a', client: 'mysql', host: 'h1', database: 'x' },
      { id: 'd2', name: 'b', client: 'mysql', host: 'h2', database: 'y' },
    ] } };
    expect(configHashOf(cfg, 'db', 'd1')).not.toBe(configHashOf(cfg, 'db', 'd2'));
  });

  it('凭据不该出现在缓存文件里（防止换机器时泄露）', () => {
    const p = store.create('缓存项目');
    store.saveCache(p.id, 'db', seed(), { kind: 'db', importedAt: new Date().toISOString(), configHash: 'h1' });

    const raw = fs.readFileSync(path.join(dir, 'projects', p.id, 'cache', 'db.json'), 'utf8');
    expect(raw).not.toContain('password');
    expect(raw).not.toContain('appSecret');
  });
});

describe('项目连接配置与凭据隔离', () => {
  it('config.json 只存连接信息，不含凭据字段', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtcfg-'));
    try {
      const store = new ProjectStore({ fsPath: dir } as any);
      const p = store.create('项目A');
      const cfg: ProjectConfig = {
        connections: {
          db: { client: 'mysql', host: 'h1', port: 3306, user: 'u', database: 'db1' },
          kingdee: { baseUrl: 'http://k3', dbId: '001', appId: 'app', user: 'admin', lcid: 2052 },
        },
      };
      store.saveConfig(p.id, cfg);

      const raw = fs.readFileSync(path.join(dir, 'projects', p.id, 'config.json'), 'utf8');
      expect(raw).toContain('"host": "h1"');
      expect(raw).not.toContain('password');
      expect(raw).not.toContain('appSecret');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('即使上游误传密码字段，落盘时也会被白名单过滤掉', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtcfg2-'));
    try {
      const store = new ProjectStore({ fsPath: dir } as any);
      const p = store.create('项目B');
      store.saveConfig(p.id, {
        connections: { db: { client: 'mysql', host: 'h2', database: 'db2', password: 'p@ss', appSecret: 'sec' } as any },
      });
      const raw = fs.readFileSync(path.join(dir, 'projects', p.id, 'config.json'), 'utf8');
      expect(raw).not.toContain('p@ss');
      expect(raw).not.toContain('sec');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('不同项目各自保存自己的连接配置，互不覆盖', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtcfg3-'));
    try {
      const store = new ProjectStore({ fsPath: dir } as any);
      const a = store.create('客户A');
      const b = store.create('客户B');
      store.saveConfig(a.id, { connections: { db: [{ id: 'default', name: 'd', client: 'mysql', host: 'a-host', database: 'a-db' }] } });
      store.saveConfig(b.id, { connections: { db: [{ id: 'default', name: 'd', client: 'mssql', host: 'b-host', database: 'b-db' }] } });

      expect(store.loadConfig(a.id).connections.db?.[0]?.host).toBe('a-host');
      expect(store.loadConfig(b.id).connections.db?.[0]?.host).toBe('b-host');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('凭据键按项目隔离：不同项目、不同类型互不冲突', () => {
    expect(projectSecretKey('p1', 'db')).not.toBe(projectSecretKey('p2', 'db'));
    expect(projectSecretKey('p1', 'db')).not.toBe(projectSecretKey('p1', 'kingdee'));
    expect(projectSecretKey('p1', 'db')).toContain('p1');
  });

  it('空配置时指纹为空（不会误判为"连接已变更"）', () => {
    expect(configHashOf(undefined, 'db')).toBe('');
    expect(configHashOf(emptyProjectConfig(), 'kingdee')).toBe('');
  });
});
