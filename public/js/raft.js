// 飞控冗余集群：成员变更 / 复制 / 提交轨迹复核引擎（纯逻辑，浏览器与 Node 共用）
//
// 规则要点：
//  - 复制事件仅在前驱索引/任期匹配时生效；冲突时只能截断未提交尾部，已提交项不得覆盖。
//  - joint(old,new) 配置项的提交须同时取得旧、新两个集合的多数；提交后进入联合阶段。
//  - final(new) 只能在联合阶段提交，且新集合必须与 joint 中的新集合一致；
//    联合阶段的每次提交都同时要求旧、新集合多数，提交 final 后才切换为新配置。
//  - 成员变更（joint+final 计为一次）至多两次。
//  - 首次失败即停止回放，错误中定位到具体副本/索引/配置阶段，此前快照全部保留。

export const LIMITS = {
  MIN_NODES: 3,
  MAX_NODES: 5,
  MAX_CHANGES: 2,
  MAX_EVENTS: 48,
};

export function normalizePeers(peers) {
  const seen = new Set();
  const out = [];
  for (const raw of peers ?? []) {
    const name = String(raw).trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function splitPeers(text) {
  return normalizePeers(String(text ?? '').split(/[,，\s]+/));
}

function sameSet(a = [], b = []) {
  const x = normalizePeers(a);
  const y = normalizePeers(b);
  return x.length === y.length && x.every((v) => y.includes(v));
}

function sameEntry(a, b) {
  if (!a || !b) return false;
  if (a.term !== b.term || (a.kind ?? 'cmd') !== (b.kind ?? 'cmd')) return false;
  if ((a.payload ?? '') !== (b.payload ?? '')) return false;
  const ka = a.kind ?? 'cmd';
  if (ka === 'joint' || ka === 'final') return sameSet(a.peers, b.peers);
  return true;
}

function auditError(code, message, evidence = {}) {
  const err = new Error(message);
  err.code = code;
  err.evidence = evidence;
  return err;
}

function majorityNeed(size) {
  return Math.floor(size / 2) + 1;
}

// 将页面录入的原始事件规整为引擎事件（peers 文本拆分为数组）
export function normalizeEvents(rawEvents) {
  return (rawEvents ?? []).map((ev) => {
    if (ev.type === 'commit') {
      return { type: 'commit', index: Number(ev.index) };
    }
    return {
      type: 'replicate',
      target: String(ev.target ?? '').trim(),
      prevLogIndex: Number(ev.prevLogIndex ?? 0),
      prevLogTerm: Number(ev.prevLogTerm ?? 0),
      entries: (ev.entries ?? []).map((e) => {
        const kind = e.kind === 'joint' || e.kind === 'final' ? e.kind : 'cmd';
        const base = { term: Number(e.term), kind };
        if (kind === 'cmd') base.payload = String(e.payload ?? '');
        else base.peers = splitPeers(e.peers);
        return base;
      }),
    };
  });
}

export function replayEvents(initialPeersInput, rawEvents) {
  const initialPeers = normalizePeers(initialPeersInput);
  const events = normalizeEvents(rawEvents);

  const state = {
    initialPeers,
    logs: {},
    globalCommitIndex: 0,
    committed: {}, // 索引 -> 已提交的规范日志项
    phase: 'stable', // stable | joint
    currentSet: [...initialPeers],
    joint: null, // { oldSet, newSet }
    changesStarted: 0,
    snapshots: [],
    error: null,
    setupError: null,
  };

  if (initialPeers.length < LIMITS.MIN_NODES || initialPeers.length > LIMITS.MAX_NODES) {
    state.setupError = {
      code: 'NODE_COUNT',
      message: `初始节点数须为 ${LIMITS.MIN_NODES}-${LIMITS.MAX_NODES} 个，当前为 ${initialPeers.length} 个`,
    };
    return state;
  }
  if (events.length > LIMITS.MAX_EVENTS) {
    state.setupError = {
      code: 'EVENT_LIMIT',
      message: `复制/提交事件不得超过 ${LIMITS.MAX_EVENTS} 项，当前为 ${events.length} 项`,
    };
    return state;
  }

  for (const p of initialPeers) state.logs[p] = [];

  // 预扫描：配置项中出现的节点属于拓扑已知节点（新节点可在 joint 提交前追日志）
  const known = new Set(initialPeers);
  for (const ev of events) {
    if (ev.type !== 'replicate') continue;
    for (const e of ev.entries ?? []) {
      if (e.kind === 'joint' || e.kind === 'final') e.peers.forEach((p) => known.add(p));
    }
  }

  events.forEach((ev, i) => {
    if (state.error) return;
    try {
      step(state, ev, i + 1, known);
    } catch (err) {
      state.error = {
        seq: i + 1,
        event: ev,
        code: err.code,
        message: err.message,
        evidence: err.evidence ?? {},
      };
    }
  });

  return state;
}

function replicaCommitIndex(state, peer) {
  const log = state.logs[peer] ?? [];
  let c = 0;
  for (let i = 1; i <= Math.min(state.globalCommitIndex, log.length); i++) {
    if (sameEntry(log[i - 1], state.committed[i])) c = i;
    else break;
  }
  return c;
}

function effectiveConfig(state) {
  if (state.phase === 'joint') {
    return [
      { role: 'old', peers: [...state.joint.oldSet] },
      { role: 'new', peers: [...state.joint.newSet] },
    ];
  }
  return [{ role: 'config', peers: [...state.currentSet] }];
}

function buildSnapshot(state, seq, event, extra) {
  return {
    seq,
    eventType: event.type,
    commitIndex: state.globalCommitIndex,
    phase: state.phase,
    changesStarted: state.changesStarted,
    config: effectiveConfig(state),
    replicas: Object.keys(state.logs).map((peer) => ({
      peer,
      commitIndex: replicaCommitIndex(state, peer),
      log: state.logs[peer].map((e, idx) => ({ index: idx + 1, ...e })),
    })),
    ...extra,
  };
}

function step(state, event, seq, known) {
  if (event.type === 'replicate') applyReplicate(state, event, seq, known);
  else if (event.type === 'commit') applyCommit(state, event, seq);
  else throw auditError('UNKNOWN_EVENT', `未知事件类型：${event.type}`, { event });
}

function applyReplicate(state, ev, seq, known) {
  const target = ev.target;
  if (!target || !known.has(target)) {
    throw auditError('UNKNOWN_TARGET', `复制目标节点 “${target ?? '(空)'}” 不在初始节点或任何配置的新集合中`, {
      target,
      known: [...known],
    });
  }
  if (!state.logs[target]) state.logs[target] = [];
  const log = state.logs[target];

  const { prevLogIndex, prevLogTerm, entries } = ev;
  if (!Number.isInteger(prevLogIndex) || prevLogIndex < 0 || !Number.isInteger(prevLogTerm) || prevLogTerm < 0) {
    throw auditError('BAD_PREV', '前驱索引/任期必须为非负整数', { target, prevLogIndex, prevLogTerm });
  }
  if (prevLogIndex > log.length) {
    throw auditError('PREV_MISMATCH', `节点 ${target} 缺少前驱：索引 ${prevLogIndex} 超出其日志长度 ${log.length}`, {
      target,
      expected: { index: prevLogIndex, term: prevLogTerm },
      actual: null,
    });
  }
  if (prevLogIndex > 0) {
    const prev = log[prevLogIndex - 1];
    if (!prev || prev.term !== prevLogTerm) {
      throw auditError(
        'PREV_MISMATCH',
        `节点 ${target} 前驱不匹配：index=${prevLogIndex} 处实际任期为 ${prev ? prev.term : '缺失'}，要求任期 ${prevLogTerm}`,
        { target, expected: { index: prevLogIndex, term: prevLogTerm }, actual: prev ? prev.term : null },
      );
    }
  }

  let cursor = prevLogIndex;
  for (const entry of entries) {
    const idx = cursor + 1;
    const existing = log[idx - 1];
    if (existing) {
      if (sameEntry(existing, entry)) {
        cursor = idx;
        continue; // 幂等：完全相同的日志项直接跳过
      }
      if (idx <= replicaCommitIndex(state, target)) {
        throw auditError(
          'ILLEGAL_OVERWRITE',
          `节点 ${target} 的索引 ${idx} 为已提交项（任期 ${existing.term}），不得用任期 ${entry.term} 的日志项覆盖或截断`,
          { target, index: idx, committedTerm: existing.term, incomingTerm: entry.term },
        );
      }
      log.length = idx - 1; // 仅截断未提交尾部
      log.push(entry);
    } else {
      if (idx !== log.length + 1) {
        throw auditError('LOG_HOLE', `节点 ${target} 日志在索引 ${idx} 处存在空洞，无法追加`, { target, index: idx });
      }
      log.push(entry);
    }
    cursor = idx;
  }

  state.snapshots.push(
    buildSnapshot(state, seq, ev, {
      replicate: { target, prevLogIndex, prevLogTerm, appended: entries.length },
    }),
  );
}

function allPeersOrdered(state) {
  return Object.keys(state.logs);
}

function pickCanonical(state, index) {
  for (const peer of allPeersOrdered(state)) {
    const e = state.logs[peer][index - 1];
    if (e) return e;
  }
  return null;
}

function evaluateSets(state, index, canonical) {
  const kind = canonical.kind ?? 'cmd';
  if (kind === 'joint') {
    if (state.phase !== 'stable') {
      throw auditError(
        'JOINT_IN_JOINT',
        `索引 ${index} 的 joint 配置提交时仍处于联合阶段：上一次 joint(old,new) 尚未由 final 提交收尾`,
        { index },
      );
    }
    if (state.changesStarted >= LIMITS.MAX_CHANGES) {
      throw auditError(
        'CHANGE_LIMIT',
        `成员变更至多 ${LIMITS.MAX_CHANGES} 次，索引 ${index} 的 joint 已构成第 ${state.changesStarted + 1} 次变更`,
        { index, changesStarted: state.changesStarted },
      );
    }
    const newSet = normalizePeers(canonical.peers);
    if (newSet.length === 0) throw auditError('BAD_CONFIG', `索引 ${index} 的 joint 新集合为空`, { index });
    if (sameSet(newSet, state.currentSet)) {
      throw auditError('BAD_CONFIG', `索引 ${index} 的 joint 新集合与当前配置完全相同，无成员变更`, { index });
    }
    return [
      { role: 'old', peers: [...state.currentSet] },
      { role: 'new', peers: newSet },
    ];
  }
  if (kind === 'final') {
    if (state.phase !== 'joint') {
      throw auditError(
        'FINAL_WITHOUT_JOINT',
        `索引 ${index} 的 final(new) 提交时 joint(old,new) 尚未生效：成员变更必须先提交 joint 并在其生效期间提交 final`,
        { index },
      );
    }
    const newSet = normalizePeers(canonical.peers);
    if (!sameSet(newSet, state.joint.newSet)) {
      throw auditError(
        'FINAL_SET_MISMATCH',
        `索引 ${index} 的 final 新集合 {${newSet.join(',')}} 与 joint 声明的新集合 {${state.joint.newSet.join(',')}} 不一致`,
        { index, finalPeers: newSet, jointPeers: [...state.joint.newSet] },
      );
    }
    return [
      { role: 'old', peers: [...state.joint.oldSet] },
      { role: 'new', peers: [...state.joint.newSet] },
    ];
  }
  if (state.phase === 'joint') {
    return [
      { role: 'old', peers: [...state.joint.oldSet] },
      { role: 'new', peers: [...state.joint.newSet] },
    ];
  }
  return [{ role: 'config', peers: [...state.currentSet] }];
}

function applyCommit(state, ev, seq) {
  const upTo = ev.index;
  if (!Number.isInteger(upTo) || upTo <= 0) {
    throw auditError('BAD_COMMIT', '提交索引必须为正整数', { index: upTo });
  }
  if (upTo <= state.globalCommitIndex) {
    throw auditError(
      'BAD_COMMIT',
      `提交索引 ${upTo} 不大于已提交索引 ${state.globalCommitIndex}，提交不得回退或重复`,
      { index: upTo, commitIndex: state.globalCommitIndex },
    );
  }

  const quorumChecks = [];
  for (let i = state.globalCommitIndex + 1; i <= upTo; i++) {
    const canonical = pickCanonical(state, i);
    if (!canonical) {
      throw auditError('NO_ENTRY', `没有任何副本在索引 ${i} 持有日志项，该索引无法提交`, { index: i });
    }
    const matching = allPeersOrdered(state).filter((p) => sameEntry(state.logs[p][i - 1], canonical));
    const sets = evaluateSets(state, i, canonical);

    const checked = sets.map((s) => {
      const size = s.peers.length;
      const need = majorityNeed(size);
      const voters = s.peers.filter((p) => matching.includes(p));
      return { role: s.role, set: s.peers, size, need, voters, satisfied: voters.length >= need };
    });
    const failed = checked.find((c) => !c.satisfied);
    if (failed) {
      throw auditError(
        'QUORUM_FAILED',
        `索引 ${i}（任期 ${canonical.term}）未取得${failed.role === 'config' ? '配置' : failed.role === 'old' ? '旧集合' : '新集合'}多数：` +
          `集合 {${failed.set.join(',')}} 需 ${failed.need}/${failed.size}，匹配副本仅 ${failed.voters.length}（${failed.voters.join(',') || '无'}）`,
        {
          index: i,
          term: canonical.term,
          kind: canonical.kind ?? 'cmd',
          failedRole: failed.role,
          missing: failed.set.filter((p) => !failed.voters.includes(p)),
          checks: checked,
        },
      );
    }

    quorumChecks.push({ index: i, kind: canonical.kind ?? 'cmd', term: canonical.term, sets: checked });
    state.committed[i] = canonical;

    // 配置阶段随该索引提交而切换
    if (canonical.kind === 'joint') {
      state.joint = { oldSet: [...state.currentSet], newSet: normalizePeers(canonical.peers) };
      state.phase = 'joint';
      state.changesStarted += 1;
    } else if (canonical.kind === 'final') {
      state.currentSet = [...state.joint.newSet];
      state.joint = null;
      state.phase = 'stable';
    }
  }

  state.globalCommitIndex = upTo;
  state.snapshots.push(buildSnapshot(state, seq, ev, { commit: { upTo, quorumChecks } }));
}
