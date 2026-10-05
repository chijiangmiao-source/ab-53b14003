#!/usr/bin/env node
// 一次性验收服务 verify：
//   1) 代码测试（node --test）
//   2) 页面构建检查（脚本语法 + HTML 引用资源齐全）
//   3) 业务场景复核（联合多数 / 配置阶段 / 非法截断等）
//   4) HTTP 冒烟（静态站点 + /health）
// 全部通过以退出码 0 结束；任一失败退出码非 0。
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';
import { replayEvents } from './public/js/raft.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const failures = [];
let passed = 0;

function ok(msg) {
  passed += 1;
  console.log(`  ✔ ${msg}`);
}
function fail(msg) {
  failures.push(msg);
  console.error(`  ✘ ${msg}`);
}
function section(name) {
  console.log(`\n[${name}]`);
}

// ---------- 1. 代码测试 ----------
section('1/4 代码测试 (node --test)');
{
  const r = spawnSync(process.execPath, ['--test', 'test/'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status === 0) ok('node:test 全部通过');
  else fail(`node:test 失败（退出码 ${r.status}）`);
}

// ---------- 2. 页面构建检查 ----------
section('2/4 页面构建检查');
{
  const syntaxTargets = ['public/js/raft.js', 'public/js/app.js', 'server.js', 'verify.js'];
  for (const rel of syntaxTargets) {
    const r = spawnSync(process.execPath, ['--check', rel], { cwd: ROOT, encoding: 'utf8' });
    if (r.status === 0) ok(`语法检查 ${rel}`);
    else fail(`语法错误 ${rel}: ${r.stderr.trim()}`);
  }

  const html = await readFile(path.join(ROOT, 'public/index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (ref.startsWith('http') || ref.startsWith('//')) continue;
    try {
      await readFile(path.join(ROOT, 'public', ref));
      ok(`页面引用资源存在: ${ref}`);
    } catch {
      fail(`页面引用资源缺失: ${ref}`);
    }
  }
  if (html.includes('js/app.js') && html.includes('js/raft.js') && html.includes('css/styles.css')) {
    ok('index.html 已接入引擎脚本、页面脚本与样式');
  } else {
    fail('index.html 脚本/样式引用不完整');
  }
}

// ---------- 3. 业务场景复核（联合多数与配置阶段） ----------
section('3/4 业务场景复核');
const R = (target, prevLogIndex, prevLogTerm, entries) =>
  ({ type: 'replicate', target, prevLogIndex, prevLogTerm, entries });
const C = (index) => ({ type: 'commit', index });
const cmd = (term, payload) => ({ term, kind: 'cmd', payload });
const joint = (term, peers) => ({ term, kind: 'joint', peers });
const finalCfg = (term, peers) => ({ term, kind: 'final', peers });

function expectOk(name, events, peers = 'A B C') {
  const r = replayEvents(peers, events);
  if (!r.error) ok(`${name}：回放通过`);
  else fail(`${name}：预期通过，实际于 #${r.error.seq} 报 ${r.error.code} — ${r.error.message}`);
  return r;
}
function expectError(name, events, code, check, peers = 'A B C') {
  const r = replayEvents(peers, events);
  if (!r.error) {
    fail(`${name}：预期失败 ${code}，实际回放通过`);
    return;
  }
  if (r.error.code !== code) {
    fail(`${name}：预期 ${code}，实际 ${r.error.code} — ${r.error.message}`);
    return;
  }
  if (check && !check(r.error)) {
    fail(`${name}：错误证据不符合预期 — ${JSON.stringify(r.error.evidence)}`);
    return;
  }
  ok(`${name}：按预期在事件 #${r.error.seq} 报 ${code}（此前 ${r.snapshots.length} 个快照已保留）`);
}

// 场景一：合法联合变更，joint 提交需旧∩新双多数，final 后配置切换
const legal = [
  R('A', 0, 0, [cmd(1, 'set x=1')]),
  R('B', 0, 0, [cmd(1, 'set x=1')]),
  C(1),
  R('A', 1, 1, [joint(2, 'A,B,D')]),
  R('B', 1, 1, [joint(2, 'A,B,D')]),
  R('D', 0, 0, [cmd(1, 'set x=1'), joint(2, 'A,B,D')]),
  C(2),
  R('A', 2, 2, [finalCfg(2, 'A,B,D')]),
  R('B', 2, 2, [finalCfg(2, 'A,B,D')]),
  R('D', 2, 2, [finalCfg(2, 'A,B,D')]),
  C(3),
];
{
  const r = expectOk('合法 joint(old,new)→final(new)', legal);
  if (!r.error) {
    const jointSnap = r.snapshots.find((s) => s.commit?.quorumChecks?.some((q) => q.kind === 'joint'));
    const q = jointSnap.commit.quorumChecks.find((x) => x.kind === 'joint');
    const oldOk = q.sets.find((s) => s.role === 'old')?.satisfied;
    const newOk = q.sets.find((s) => s.role === 'new')?.satisfied;
    if (oldOk && newOk) ok('joint 提交同时取得旧集合与新集合多数');
    else fail('joint 提交的旧/新双多数标记不正确');
    if (jointSnap.phase === 'joint') ok('joint 提交后进入联合生效阶段');
    else fail('joint 提交后阶段未切换为 joint');
    const finalSnap = r.snapshots.at(-1);
    if (finalSnap.phase === 'stable' && finalSnap.config[0].peers.join(',') === 'A,B,D') {
      ok('final 提交后退出联合阶段，有效配置切换为 {A,B,D}');
    } else fail('final 提交后配置阶段不正确');
  }
}

// 场景二：联合多数——旧集合满足但新集合不足
expectError(
  'joint 提交新集合多数不足（旧集合已足）',
  [
    R('A', 0, 0, [joint(1, 'A,B,C,D')]),
    R('B', 0, 0, [joint(1, 'A,B,C,D')]),
    C(1),
  ],
  'QUORUM_FAILED',
  (e) => e.evidence.failedRole === 'new' && e.evidence.missing.includes('D'),
);

// 场景三：联合生效期间普通指令也必须双多数
{
  const events = [...legal];
  events.push(
    R('A', 3, 2, [joint(3, 'A,B,D,E')]),
    R('B', 3, 2, [joint(3, 'A,B,D,E')]),
    R('D', 3, 2, [joint(3, 'A,B,D,E')]),
    R('E', 0, 0, [cmd(1, 'set x=1'), joint(2, 'A,B,D'), finalCfg(2, 'A,B,D'), joint(3, 'A,B,D,E')]),
    C(4),
    R('E', 4, 3, [cmd(3, 'arm')]), // 联合阶段仅新节点 E 持有
    C(5),
  );
  expectError('联合阶段普通指令缺旧集合多数', events, 'QUORUM_FAILED',
    (e) => e.evidence.failedRole === 'old' && e.evidence.index === 5);
}

// 场景四：配置阶段——未经 joint 提交 final
expectError(
  '未提交 joint 即提交 final',
  [
    R('A', 0, 0, [finalCfg(1, 'A,B,D')]),
    R('B', 0, 0, [finalCfg(1, 'A,B,D')]),
    R('D', 0, 0, [finalCfg(1, 'A,B,D')]),
    C(1),
  ],
  'FINAL_WITHOUT_JOINT',
);

// 场景五：final 集合与 joint 新集合不一致
expectError(
  'final 新集合与 joint 声明不一致',
  [
    R('A', 0, 0, [joint(1, 'A,B,C,D')]),
    R('B', 0, 0, [joint(1, 'A,B,C,D')]),
    R('C', 0, 0, [joint(1, 'A,B,C,D')]),
    C(1),
    R('A', 1, 1, [finalCfg(1, 'A,B,E')]),
    R('B', 1, 1, [finalCfg(1, 'A,B,E')]),
    R('E', 0, 0, [finalCfg(1, 'A,B,E')]),
    C(2),
  ],
  'FINAL_SET_MISMATCH',
);

// 场景六：非法截断已提交尾部；未提交尾部允许截断
expectError(
  '复制覆盖已提交项',
  [
    R('A', 0, 0, [cmd(1, 'x=1')]),
    R('B', 0, 0, [cmd(1, 'x=1')]),
    C(1),
    R('B', 0, 0, [cmd(2, 'x=2')]),
  ],
  'ILLEGAL_OVERWRITE',
  (e) => e.evidence.target === 'B' && e.evidence.index === 1,
);
{
  const r = expectOk('前驱匹配时允许截断未提交尾部', [
    R('A', 0, 0, [cmd(1, 'a')]),
    R('B', 0, 0, [cmd(1, 'a')]),
    C(1),
    R('A', 1, 1, [cmd(2, 'b')]),
    R('A', 1, 1, [cmd(3, 'c')]),
  ]);
  if (!r.error && r.logs.A[1].term === 3) ok('未提交项 t2/b 已被 t3/c 替换，已提交项保持不变');
}

// 场景七：前驱不匹配定位到缺失副本
expectError(
  '前驱索引缺失',
  [R('C', 1, 1, [cmd(1, 'z')])],
  'PREV_MISMATCH',
  (e) => e.evidence.target === 'C',
);

// ---------- 4. HTTP 冒烟 ----------
section('4/4 HTTP 冒烟');
await new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    try {
      {
        const res = await fetch(`${base}/health`);
        const body = await res.json();
        if (res.status === 200 && body.status === 'ok') ok(`GET /health -> 200 ${JSON.stringify(body)}`);
        else fail(`GET /health 异常: ${res.status} ${JSON.stringify(body)}`);
      }
      {
        const res = await fetch(`${base}/`);
        const body = await res.text();
        if (res.status === 200 && body.includes('飞控冗余集群') && body.includes('js/app.js')) {
          ok('GET / -> 200 且返回复核页面');
        } else fail(`GET / 内容异常 (${res.status})`);
      }
      {
        const res = await fetch(`${base}/js/raft.js`);
        if (res.status === 200 && res.headers.get('content-type')?.includes('javascript')) {
          ok('GET /js/raft.js -> 200 (javascript MIME)');
        } else fail(`GET /js/raft.js 异常: ${res.status}`);
      }
      {
        const res = await fetch(`${base}/does-not-exist`);
        if (res.status === 404) ok('GET 未知路径 -> 404');
        else fail(`未知路径应 404，实际 ${res.status}`);
      }
    } catch (err) {
      fail(`HTTP 冒烟请求失败: ${err.message}`);
    } finally {
      server.close(() => resolve());
    }
  });
});

// ---------- 汇总 ----------
console.log(`\n==== 验收汇总：${passed} 项通过，${failures.length} 项失败 ====`);
if (failures.length) {
  for (const f of failures) console.error(`  - ${f}`);
  console.error('verify 结果：不通过');
  process.exit(1);
}
console.log('verify 结果：全部通过');
process.exit(0);
