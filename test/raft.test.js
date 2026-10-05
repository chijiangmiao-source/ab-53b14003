import test from 'node:test';
import assert from 'node:assert/strict';
import { replayEvents, LIMITS } from '../public/js/raft.js';

const rep = (target, prevLogIndex, prevLogTerm, entries) =>
  ({ type: 'replicate', target, prevLogIndex, prevLogTerm, entries });
const commit = (index) => ({ type: 'commit', index });
const cmd = (term, payload) => ({ term, kind: 'cmd', payload });
const joint = (term, peers) => ({ term, kind: 'joint', peers });
const finalCfg = (term, peers) => ({ term, kind: 'final', peers });

// 完整的一次合法联合变更：{A,B,C} -> joint{A,B,C,D} -> final{A,B,D}
function changeOnce(peers) {
  return [
    rep('A', 0, 0, [cmd(1, 'set x=1')]),
    rep('B', 0, 0, [cmd(1, 'set x=1')]),
    commit(1),
    rep('A', 1, 1, [joint(2, 'A,B,D')]),
    rep('B', 1, 1, [joint(2, 'A,B,D')]),
    rep('D', 0, 0, [cmd(1, 'set x=1'), joint(2, 'A,B,D')]),
    commit(2), // 旧 {A,B,C} A,B=2/2 需；新 {A,B,C,D} A,B,D=3/3 需
    rep('A', 2, 2, [finalCfg(2, 'A,B,D')]),
    rep('B', 2, 2, [finalCfg(2, 'A,B,D')]),
    rep('D', 2, 2, [finalCfg(2, 'A,B,D')]),
    commit(3), // 联合阶段：旧 A,B=2 需；新 A,B,D=3 需；提交后切换为 {A,B,D}
  ];
}

test('合法 joint -> final：联合双多数与阶段切换均通过', () => {
  const r = replayEvents('A B C', changeOnce());
  assert.equal(r.error, null);
  assert.equal(r.globalCommitIndex, 3);
  assert.equal(r.phase, 'stable');
  assert.deepEqual(r.currentSet, ['A', 'B', 'D']);
  assert.equal(r.changesStarted, 1);
  const last = r.snapshots.at(-1);
  assert.equal(last.eventType, 'commit');
  assert.deepEqual(last.config, [{ role: 'config', peers: ['A', 'B', 'D'] }]);
  // final 提交快照中旧、新两组多数都有记录
  const q = last.commit.quorumChecks.find((c) => c.kind === 'final');
  assert.equal(q.sets.length, 2);
  assert.deepEqual(q.sets.map((s) => s.role), ['old', 'new']);
});

test('joint 提交时新集合多数不足 -> QUORUM_FAILED 并定位缺失副本', () => {
  const r = replayEvents('A B C', [
    rep('A', 0, 0, [joint(1, 'A,B,C,D')]),
    rep('B', 0, 0, [joint(1, 'A,B,C,D')]),
    commit(1), // 旧 A,B 满足；新 4 节点需 3，仅 A,B
  ]);
  assert.equal(r.error.code, 'QUORUM_FAILED');
  assert.equal(r.error.evidence.index, 1);
  assert.equal(r.error.evidence.failedRole, 'new');
  assert.deepEqual(r.error.evidence.missing.sort(), ['C', 'D']);
  assert.equal(r.error.seq, 3);
  assert.equal(r.snapshots.length, 2, '失败前快照保留');
});

test('联合阶段普通指令缺失旧集合多数 -> QUORUM_FAILED(old)', () => {
  const events = changeOnce();
  // final 已提交，配置为 {A,B,D}。再发起第二次变更以进入联合阶段：
  events.push(
    rep('A', 3, 2, [joint(3, 'A,B,D,E')]),
    rep('B', 3, 2, [joint(3, 'A,B,D,E')]),
    rep('D', 3, 2, [joint(3, 'A,B,D,E')]),
    rep('E', 0, 0, [cmd(1, 'set x=1'), joint(2, 'A,B,D'), finalCfg(2, 'A,B,D'), joint(3, 'A,B,D,E')]),
    commit(4), // 旧 {A,B,D} A,B,D=3 需；新 {A,B,D,E} A,B,D,E=4 需
    // 联合阶段的新指令只复制给新节点 E：旧集合 {A,B,D} 零匹配
    rep('E', 4, 3, [cmd(3, 'arm')]),
    commit(5),
  );
  const r = replayEvents('A B C', events);
  assert.equal(r.error.code, 'QUORUM_FAILED');
  assert.equal(r.error.evidence.index, 5);
  assert.equal(r.error.evidence.failedRole, 'old');
});

test('未经 joint 直接提交 final -> FINAL_WITHOUT_JOINT', () => {
  const r = replayEvents('A B C', [
    rep('A', 0, 0, [finalCfg(1, 'A,B,D')]),
    rep('B', 0, 0, [finalCfg(1, 'A,B,D')]),
    rep('D', 0, 0, [finalCfg(1, 'A,B,D')]),
    commit(1),
  ]);
  assert.equal(r.error.code, 'FINAL_WITHOUT_JOINT');
});

test('final 新集合与 joint 声明不一致 -> FINAL_SET_MISMATCH', () => {
  const r = replayEvents('A B C', [
    rep('A', 0, 0, [joint(1, 'A,B,C,D')]),
    rep('B', 0, 0, [joint(1, 'A,B,C,D')]),
    rep('C', 0, 0, [joint(1, 'A,B,C,D')]),
    commit(1),
    rep('A', 1, 1, [finalCfg(1, 'A,B,E')]),
    rep('B', 1, 1, [finalCfg(1, 'A,B,E')]),
    rep('E', 0, 0, [finalCfg(1, 'A,B,E')]),
    commit(2),
  ]);
  assert.equal(r.error.code, 'FINAL_SET_MISMATCH');
});

test('复制覆盖已提交项 -> ILLEGAL_OVERWRITE，且此前提交不被破坏', () => {
  const r = replayEvents('A B C', [
    rep('A', 0, 0, [cmd(1, 'x=1')]),
    rep('B', 0, 0, [cmd(1, 'x=1')]),
    commit(1),
    rep('B', 0, 0, [cmd(2, 'x=2')]), // 试图截断/覆盖 B 的已提交索引 1
  ]);
  assert.equal(r.error.code, 'ILLEGAL_OVERWRITE');
  assert.equal(r.error.evidence.target, 'B');
  assert.equal(r.error.evidence.index, 1);
  assert.equal(r.committed[1].term, 1);
  assert.equal(r.globalCommitIndex, 1);
  assert.equal(r.snapshots.length, 3, '保留到提交成功为止的快照');
});

test('前驱不匹配 -> PREV_MISMATCH', () => {
  const r = replayEvents('A B C', [
    rep('A', 1, 1, [cmd(1, 'x')]), // A 日志为空，索引 1 不存在
  ]);
  assert.equal(r.error.code, 'PREV_MISMATCH');
  assert.deepEqual(r.logs.A, []);
});

test('仅允许截断未提交尾部：冲突项在提交点之后可替换', () => {
  const r = replayEvents('A B C', [
    rep('A', 0, 0, [cmd(1, 'a')]),
    rep('B', 0, 0, [cmd(1, 'a')]),
    commit(1),
    rep('A', 1, 1, [cmd(2, 'b')]), // 未提交
    rep('A', 1, 1, [cmd(3, 'c')]), // 前驱匹配，截断未提交的 t2/b 后追加 t3/c
  ]);
  assert.equal(r.error, null);
  assert.equal(r.logs.A.length, 2);
  assert.deepEqual(r.logs.A[1], { term: 3, kind: 'cmd', payload: 'c' });
  assert.deepEqual(r.logs.A[0], { term: 1, kind: 'cmd', payload: 'a' });
});

test('幂等重复复制相同日志项不改变日志', () => {
  const r = replayEvents('A B C', [
    rep('A', 0, 0, [cmd(1, 'a'), cmd(1, 'b')]),
    rep('A', 0, 0, [cmd(1, 'a'), cmd(1, 'b')]),
  ]);
  assert.equal(r.error, null);
  assert.equal(r.logs.A.length, 2);
});

test('成员变更至多两次 -> CHANGE_LIMIT', () => {
  const events = changeOnce('A B C');
  // 第二次：{A,B,D} -> joint {A,B,D,E} -> final
  events.push(
    rep('A', 3, 2, [joint(3, 'A,B,D,E')]),
    rep('B', 3, 2, [joint(3, 'A,B,D,E')]),
    rep('D', 3, 2, [joint(3, 'A,B,D,E')]),
    rep('E', 0, 0, [cmd(1, 'set x=1'), joint(2, 'A,B,D'), finalCfg(2, 'A,B,D'), joint(3, 'A,B,D,E')]),
    commit(4),
    rep('A', 4, 3, [finalCfg(3, 'A,B,D,E')]),
    rep('B', 4, 3, [finalCfg(3, 'A,B,D,E')]),
    rep('D', 4, 3, [finalCfg(3, 'A,B,D,E')]),
    commit(5),
  );
  // 第三次变更的 joint 尝试（E 需先追平第二次变更的 final 项）
  events.push(
    rep('E', 4, 3, [finalCfg(3, 'A,B,D,E')]),
    rep('A', 5, 3, [joint(4, 'A,D,E')]),
    rep('D', 5, 3, [joint(4, 'A,D,E')]),
    rep('E', 5, 3, [joint(4, 'A,D,E')]),
    commit(6),
  );
  const r = replayEvents('A B C', events);
  assert.equal(r.error.code, 'CHANGE_LIMIT');
});

test('录入约束：节点数与事件数超限返回 setupError', () => {
  assert.equal(replayEvents('A B', []).setupError.code, 'NODE_COUNT');
  assert.equal(replayEvents('A B C D E F', []).setupError.code, 'NODE_COUNT');
  const many = Array.from({ length: LIMITS.MAX_EVENTS + 1 }, () =>
    rep('A', 0, 0, [cmd(1, 'x')]));
  assert.equal(replayEvents('A B C', many).setupError.code, 'EVENT_LIMIT');
});

test('提交索引回退 -> BAD_COMMIT', () => {
  const r = replayEvents('A B C', [
    rep('A', 0, 0, [cmd(1, 'x')]),
    rep('B', 0, 0, [cmd(1, 'x')]),
    commit(1),
    commit(1),
  ]);
  assert.equal(r.error.code, 'BAD_COMMIT');
});
