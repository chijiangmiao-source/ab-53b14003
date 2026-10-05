// 引擎单元测试（零依赖断言），node test/engine.test.mjs
import { replay } from '../src/engine.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) passed += 1;
  else { failed += 1; failures.push(msg); console.error('  ✘ ' + msg); }
}
function section(name) { console.log('\n== ' + name); }

function jointEntry(newSet, term = 1, old) {
  return { term, config: { kind: 'joint', ...(old ? { old } : {}), new: newSet } };
}
const finalEntry = (nodes, term = 1) => ({ term, config: { kind: 'final', nodes } });

// ---------- 普通提交 ----------
section('基本复制与多数提交');
{
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'commit', index: 1 },
    ],
  });
  assert(r.ok === true, '两副本持有即可提交(3 节点多数 2)');
  assert(r.snapshots.length === 3, '应产生 3 个快照');
  assert(r.snapshots[2].commitIndex === 1, '提交下标为 1');
  assert(r.snapshots[2].phase.mode === 'stable', '初始为 stable');
}
{
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'commit', index: 1 },
    ],
  });
  assert(!r.ok && r.failure.category === 'quorum', '单副本不能凑够多数');
  assert(r.failure.check.matched.length === 1 && r.failure.check.missing.includes('b'), '定位缺失副本 b');
  assert(r.snapshots.length === 1, '失败前快照保留(仅 1 个)');
  assert(r.snapshots[0].commitIndex === 0, '失败提交不落盘 commitIndex');
}

// ---------- 前驱匹配 / 截断 ----------
section('前驱匹配、追加与截断');
{
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'b', prevLogIndex: 1, prevLogTerm: 1, entries: [{ term: 2 }] },
    ],
  });
  assert(!r.ok && r.failure.category === 'predecessor', '空日志前驱下标 1 不匹配');
  assert(/缺失该副本|日志短于/.test(r.failure.message), '消息定位缺失匹配副本');
}
{
  // b: [t1]，收到 prev(1,t2) -> 任期不符
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'replicate', target: 'b', prevLogIndex: 1, prevLogTerm: 2, entries: [{ term: 3 }] },
    ],
  });
  assert(!r.ok && r.failure.category === 'predecessor', '前驱任期不符须拒绝');
  assert(r.snapshots.length === 1, '拒绝后保留此前快照');
  assert(r.failure.replicas.find((x) => x.node === 'b').length === 1, '被拒副本日志不变');
}
{
  // 同任期条目幂等跳过
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }, { term: 1 }] },
      { type: 'replicate', target: 'a', prevLogIndex: 1, prevLogTerm: 1, entries: [{ term: 1 }] },
    ],
  });
  assert(r.ok, '相同任期连续区间重发幂等');
  assert(r.snapshots[1].detail.skipped === 1 && r.snapshots[1].detail.appended === 0, '跳过 1 追加 0');
}
{
  // 未提交尾部截断合法：b: [t1]，prev=0/t0 发 [t2] -> 截断下标 1
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 2 }, { term: 2 }] },
    ],
  });
  assert(r.ok, '未提交尾部允许截断');
  assert(r.snapshots[1].detail.truncatedFrom === 1 && r.snapshots[1].detail.appended === 2, '自下标 1 截断并追加 2');
  const b = r.snapshots[1].replicas.find((x) => x.node === 'b');
  assert(b.length === 2 && b.tail[0].term === 2, '截断后日志为两项 t2');
}
{
  // 已提交项不得覆盖
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'commit', index: 1 },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 2 }] },
    ],
  });
  assert(!r.ok && r.failure.category === 'truncate', '覆盖已提交项须判定非法截断');
  assert(r.failure.conflictIndex === 1 && r.failure.commitIndex === 1, '定位冲突下标与提交下标');
  assert(r.snapshots.length === 3, '保留提交后的快照');
  const b = r.failure.replicas.find((x) => x.node === 'b');
  assert(b.length === 1 && b.tail[0].term === 1, '失败事件不修改日志');
}

// ---------- 联合成员变更 ----------
section('joint/final 配置阶段与联合多数');
{
  // 3->4 正确流程：joint 复制到 a,b(旧多数) + a,d(新集合 a,b,c,d 多数需 a,b 或 a,d)
  const events = [
    { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
    { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
    { type: 'replicate', target: 'd', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
    { type: 'commit', index: 1 },
    { type: 'replicate', target: 'a', prevLogIndex: 1, prevLogTerm: 1, entries: [finalEntry(['a', 'b', 'c', 'd'])] },
    { type: 'replicate', target: 'b', prevLogIndex: 1, prevLogTerm: 1, entries: [finalEntry(['a', 'b', 'c', 'd'])] },
    { type: 'replicate', target: 'd', prevLogIndex: 1, prevLogTerm: 1, entries: [finalEntry(['a', 'b', 'c', 'd'])] },
    { type: 'commit', index: 2 },
  ];
  const r = replay({ nodes: ['a', 'b', 'c'], events });
  assert(r.ok, '联合变更完整流程应通过');
  assert(r.snapshots[3].phase.mode === 'joint', '提交 joint 后进入 joint 阶段');
  assert(r.snapshots[7].phase.mode === 'stable', '提交 final 后恢复 stable');
  assert(eq(r.snapshots[7].phase.nodes, ['a', 'b', 'c', 'd']), 'stable 节点集为新集合');
  const jointCommit = r.snapshots[3].detail.checks[0];
  assert(jointCommit.oldMatched.length === 2 && jointCommit.newMatched.length === 3, '联合阶段双侧多数统计正确');
  const finalCommit = r.snapshots[7].detail.checks[0];
  assert(finalCommit.oldMatched.length === 2 && finalCommit.newMatched.length === 3, 'final 也按联合多数计票');
  // 新节点 d 在快照中出现
  assert(r.snapshots[0].replicas.some((x) => x.node === 'd'), 'joint 出现即为新节点建空日志');
}
{
  // 缺旧集合多数：joint 仅在 a,d
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'd', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'commit', index: 1 },
    ],
  });
  assert(!r.ok && r.failure.category === 'quorum', '旧集合不足多数须失败');
  assert(r.failure.check.oldMatched.length === 1, '旧集合仅 1 匹配');
  assert(eq(r.failure.check.oldMissing, ['b', 'c']), '缺失旧集合节点 b,c');
  assert(r.failure.phase.mode === 'stable', '失败时仍为 stable（joint 未生效）');
}
{
  // 旧多数满足、新集合不足：joint 在 a,b 但 d 没有
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'commit', index: 1 },
    ],
  });
  assert(!r.ok && r.failure.category === 'quorum', '新集合不足多数须失败');
  assert(r.failure.check.newMatched.length === 2, '新集合仅 a,b 匹配（4 节点需 3）');
  assert(eq(r.failure.check.newMissing, ['c', 'd']), '缺失新集合节点 c,d');
}
{
  // final 早于 joint
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [finalEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [finalEntry(['a', 'b', 'c', 'd'])] },
      { type: 'commit', index: 1 },
    ],
  });
  assert(!r.ok && r.failure.category === 'phase', 'stable 阶段提交 final 须判错误阶段');
}
{
  // joint 生效期间普通条目也须联合多数
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'd', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'commit', index: 1 },
      { type: 'replicate', target: 'a', prevLogIndex: 1, prevLogTerm: 1, entries: [{ term: 1 }] },
      { type: 'replicate', target: 'b', prevLogIndex: 1, prevLogTerm: 1, entries: [{ term: 1 }] },
      { type: 'commit', index: 2 },
    ],
  });
  assert(!r.ok, 'joint 期间普通条目仍须双侧多数');
  assert(r.failure.category === 'quorum' && r.failure.check.index === 2, '失败定位到下标 2');
  assert(eq(r.failure.check.newMissing, ['c', 'd']), '新集合缺 c,d（4 节点需 3，仅 a,b 匹配）');
}
{
  // final 集合与 joint.new 不一致
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'd', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'commit', index: 1 },
      { type: 'replicate', target: 'a', prevLogIndex: 1, prevLogTerm: 1, entries: [finalEntry(['a', 'b', 'd', 'e'])] },
      { type: 'replicate', target: 'b', prevLogIndex: 1, prevLogTerm: 1, entries: [finalEntry(['a', 'b', 'd', 'e'])] },
      { type: 'replicate', target: 'd', prevLogIndex: 1, prevLogTerm: 1, entries: [finalEntry(['a', 'b', 'd', 'e'])] },
      { type: 'commit', index: 2 },
    ],
  });
  assert(!r.ok && r.failure.category === 'phase', 'final 集合偏离 joint.new 须判错误阶段');
}
{
  // joint 生效后、final 提交前又开启新 joint -> 复制时即判阶段错误
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'd', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'commit', index: 1 },
      { type: 'replicate', target: 'a', prevLogIndex: 1, prevLogTerm: 1, entries: [jointEntry(['a', 'b', 'c', 'd', 'e'])] },
    ],
  });
  assert(!r.ok && r.failure.category === 'phase', '联合生效期间不能开启第二次 joint');
}

// ---------- 两次成员变更 ----------
section('两次成员变更（串行完成）');
{
  const J1 = jointEntry(['a', 'b', 'c', 'd']);
  const F1 = finalEntry(['a', 'b', 'c', 'd']);
  const J2 = jointEntry(['a', 'b', 'd', 'e']); // 第二次变更，old 自动取 {a,b,c,d}
  const F2 = finalEntry(['a', 'b', 'd', 'e']);
  const repl = (target, prev, term, entries) =>
    ({ type: 'replicate', target, prevLogIndex: prev, prevLogTerm: term, entries });
  const to = (target, prev, term, entries) => repl(target, prev, term, entries);
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      to('a', 0, 0, [J1]), to('b', 0, 0, [J1]), to('d', 0, 0, [J1]),
      { type: 'commit', index: 1 },
      to('a', 1, 1, [F1]), to('b', 1, 1, [F1]), to('d', 1, 1, [F1]),
      { type: 'commit', index: 2 },
      to('a', 2, 1, [J2]), to('b', 2, 1, [J2]), to('d', 2, 1, [J2]),
      // 第二次变更引入的新节点 e 必须先补齐历史日志，前驱才匹配
      to('e', 0, 0, [J1, F1, J2]),
      { type: 'commit', index: 3 },
      to('a', 3, 1, [F2]), to('b', 3, 1, [F2]), to('d', 3, 1, [F2]), to('e', 3, 1, [F2]),
      { type: 'commit', index: 4 },
    ],
  });
  assert(r.ok, '两次串行联合变更应通过');
  assert(eq(r.snapshots.at(-1).phase.nodes, ['a', 'b', 'd', 'e']), '最终配置为第二次 new 集合');
}

// ---------- 输入约束 ----------
section('录入约束');
{
  const r1 = replay({ nodes: ['a', 'b'], events: [] });
  assert(r1.inputError && /3~5/.test(r1.inputError.message), '节点少于 3 个拒绝');
  const many = ['a', 'b', 'c', 'd', 'e', 'f'];
  const r2 = replay({ nodes: many, events: [] });
  assert(r2.inputError && /3~5/.test(r2.inputError.message), '节点多于 5 个拒绝');
  const r3 = replay({
    nodes: ['a', 'b', 'c'],
    events: Array.from({ length: 49 }, () => ({ type: 'commit', index: 1 })),
  });
  assert(r3.inputError && /48/.test(r3.inputError.message), '事件超过 48 项拒绝');
  const j3 = jointEntry(['a', 'b', 'd']);
  const r4 = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [j3] },
      { type: 'replicate', target: 'a', prevLogIndex: 1, prevLogTerm: 1, entries: [j3] },
      { type: 'replicate', target: 'a', prevLogIndex: 2, prevLogTerm: 1, entries: [j3] },
    ],
  });
  assert(r4.inputError && /成员变更/.test(r4.inputError.message), '超过两次成员变更拒绝');
}

// ---------- 快照内容 ----------
section('逐事件快照内容');
{
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0,
        entries: [{ term: 1 }, { term: 2 }] },
      { type: 'commit', index: 1 },
    ],
  });
  // commit 失败（只有 a 有），取最后成功快照
  const s = r.snapshots[0];
  const a = s.replicas.find((x) => x.node === 'a');
  assert(a.tail.length === 2 && a.tail[1].term === 2, '日志末尾展示尾部条目与索引');
  assert(a.tail[0].index === 1, '尾部条目标注日志下标');
  assert(s.commitIndex === 0, '提交前 commitIndex=0');
  assert(s.replicas.length === 3, '每个副本一行');
}

function eq(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

console.log(`\n${failed === 0 ? '✔' : '✘'} 单测通过 ${passed} 项，失败 ${failed} 项`);
process.exitCode = failed === 0 ? 0 : 1;
if (failed) console.error(failures.join('\n'));
