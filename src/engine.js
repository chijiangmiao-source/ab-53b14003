// Raft 联合成员变更复制/提交轨迹回放引擎（无依赖，浏览器与 Node 共用）
//
// 输入:
// {
//   nodes: ['a','b','c'],                    // 初始节点 3~5 个
//   events: [                                // 按序事件，至多 48 项
//     { type:'replicate', target:'a',
//       prevLogIndex:0, prevLogTerm:0,
//       entries:[ {term:1}, {term:1, config:{kind:'joint', new:['a','b','c','d']}},
//                  {term:1, config:{kind:'final', nodes:['a','b','c','d']}} ] },
//     { type:'commit', index:3 }
//   ]
// }
// 说明:
//  - 日志下标从 1 开始；prevLogIndex=0 表示从头追加。
//  - joint 条目的 old 可省略，回放器以当前生效配置补全；提供时必须一致。
//  - 输出 { ok, snapshots, failure }：
//      snapshots 为每个成功事件后的快照；failure 为首次失败（含分类），
//      失败事件不改变状态，此前快照全部保留。

export const LIMITS = Object.freeze({
  MIN_NODES: 3,
  MAX_NODES: 5,
  MAX_CHANGES: 2, // 至多两次成员变更（joint 计数）
  MAX_EVENTS: 48,
  TAIL_SIZE: 6,
});

const isInt = (v) => Number.isInteger(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
function eqSet(a, b) {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  for (const x of a) if (!sb.has(x)) return false;
  return true;
}
const majority = (n) => Math.floor(n / 2) + 1;

function inputFailure(message, eventSeq = null, extra = {}) {
  return { category: 'input', message, eventSeq, ...extra };
}

// ---- 输入校验（回放前，不计入“首次事件失败”） ----
function validateInput(input) {
  const issues = [];
  if (!input || typeof input !== 'object') return { error: inputFailure('输入必须为对象') };

  const rawNodes = Array.isArray(input.nodes) ? input.nodes : null;
  if (!rawNodes) return { error: inputFailure('缺少初始节点列表 nodes') };
  const nodes = rawNodes.map((n) => String(n).trim()).filter(Boolean);
  if (nodes.length < LIMITS.MIN_NODES || nodes.length > LIMITS.MAX_NODES) {
    issues.push(`初始节点数须为 ${LIMITS.MIN_NODES}~${LIMITS.MAX_NODES} 个，当前 ${nodes.length} 个`);
  }
  if (new Set(nodes).size !== nodes.length) issues.push('初始节点存在重复 ID');

  const events = Array.isArray(input.events) ? input.events : null;
  if (!events) return { error: inputFailure('缺少事件列表 events') };
  if (events.length > LIMITS.MAX_EVENTS) {
    issues.push(`事件数不得超过 ${LIMITS.MAX_EVENTS} 项，当前 ${events.length} 项`);
  }

  let jointCount = 0;
  const jointIndexes = new Set();
  const universe = new Set(nodes);
  events.forEach((ev, i) => {
    const seq = i + 1;
    if (!ev || (ev.type !== 'replicate' && ev.type !== 'commit')) {
      issues.push(`事件 #${seq}: 类型必须是 replicate 或 commit`);
      return;
    }
    if (ev.type === 'commit') {
      if (!isInt(ev.index) || ev.index < 1) issues.push(`事件 #${seq}: commit.index 必须为正整数`);
      return;
    }
    if (typeof ev.target !== 'string' || !ev.target.trim()) {
      issues.push(`事件 #${seq}: replicate.target 缺失`);
    }
    if (!isInt(ev.prevLogIndex) || ev.prevLogIndex < 0) {
      issues.push(`事件 #${seq}: prevLogIndex 必须为 >=0 的整数`);
    }
    if (!isInt(ev.prevLogTerm) || ev.prevLogTerm < 0) {
      issues.push(`事件 #${seq}: prevLogTerm 必须为 >=0 的整数`);
    }
    if (!Array.isArray(ev.entries) || ev.entries.length === 0) {
      issues.push(`事件 #${seq}: entries 至少包含一项连续日志`);
      return;
    }
    ev.entries.forEach((e, j) => {
      if (!e || !isInt(e.term) || e.term < 1) {
        issues.push(`事件 #${seq} 第 ${j + 1} 项日志: term 必须为正整数`);
        return;
      }
      if (e.config !== undefined && e.config !== null) {
        const c = e.config;
        if (c.kind === 'joint') {
          if (isInt(ev.prevLogIndex)) {
            // 同一全局下标的 joint 条目可被复制到多个目标，按位置去重计数
            jointIndexes.add(ev.prevLogIndex + j + 1);
          }
          jointCount = jointIndexes.size;
          if (!Array.isArray(c.new) || c.new.length === 0) {
            issues.push(`事件 #${seq} 第 ${j + 1} 项: joint 配置缺少 new 集合`);
          } else {
            c.new.forEach((n) => universe.add(String(n)));
          }
          if (c.old !== undefined) {
            if (!Array.isArray(c.old) || c.old.length === 0) {
              issues.push(`事件 #${seq} 第 ${j + 1} 项: joint.old 必须为非空数组`);
            }
          }
        } else if (c.kind === 'final') {
          if (!Array.isArray(c.nodes) || c.nodes.length === 0) {
            issues.push(`事件 #${seq} 第 ${j + 1} 项: final 配置缺少 nodes 集合`);
          } else {
            c.nodes.forEach((n) => universe.add(String(n)));
          }
        } else {
          issues.push(`事件 #${seq} 第 ${j + 1} 项: 未知配置类型 ${String(c && c.kind)}`);
        }
      }
    });
  });

  if (jointCount > LIMITS.MAX_CHANGES) {
    issues.push(`成员变更（joint）不得超过 ${LIMITS.MAX_CHANGES} 次，当前 ${jointCount} 次`);
  }
  // 复制目标必须属于初始集合或某次 joint 引入的新集合
  events.forEach((ev, i) => {
    if (ev && ev.type === 'replicate' && typeof ev.target === 'string') {
      if (!universe.has(ev.target.trim())) {
        issues.push(`事件 #${i + 1}: 目标节点 ${ev.target} 不在当前/新配置集合中`);
      }
    }
  });

  if (issues.length) return { error: inputFailure(issues.join('；')), issues };
  return { nodes, events };
}

export function replay(input, options = {}) {
  const tailSize = options.tailSize ?? LIMITS.TAIL_SIZE;
  const v = validateInput(input);
  if (v.error) {
    return { ok: false, inputError: v.error, issues: v.issues || null, snapshots: [], failure: null };
  }
  const initialNodes = v.nodes;
  const events = v.events;

  // --- 状态 ---
  const logs = new Map(); // node -> [{term, config?}]，位置 i 对应日志下标 i+1
  initialNodes.forEach((n) => logs.set(n, []));
  const canon = []; // 参考（领导者）日志
  let commitIndex = 0;
  let phase = { mode: 'stable', nodes: [...initialNodes] };

  const voters = () =>
    phase.mode === 'stable'
      ? new Set(phase.nodes)
      : new Set([...phase.old, ...phase.new]);

  function replicaView(name) {
    const log = logs.get(name) || [];
    const active = voters().has(name);
    const tail = log.slice(-tailSize).map((e, i) => ({
      index: log.length - Math.min(tailSize, log.length) + i + 1,
      term: e.term,
      config: e.config || null,
    }));
    return { node: name, length: log.length, active, tail };
  }

  function snapshot(seq, event, detail) {
    return {
      seq,
      type: event.type,
      detail,
      commitIndex,
      phase: clone(phase),
      replicas: [...logs.keys()].map(replicaView),
    };
  }

  function failAt(seq, event, category, message, extra = {}) {
    // 失败事件不落盘任何修改；快照即“此前”状态
    return {
      category, // 'predecessor' | 'truncate' | 'phase' | 'quorum'
      message,
      eventSeq: seq,
      event,
      commitIndex,
      phase: clone(phase),
      replicas: [...logs.keys()].map(replicaView),
      ...extra,
    };
  }

  // 配置条目进入参考日志时的校验（joint 只能在 stable 阶段开启）
  function admitConfig(entry, idx, seq) {
    const c = entry.config;
    if (!c) return null;
    if (c.kind === 'joint') {
      if (phase.mode !== 'stable') {
        return failAt(seq, null, 'phase',
          `日志下标 ${idx}: 尚未提交 final 结束当前 joint，不能开启新的联合配置`);
      }
      const old = phase.nodes;
      if (c.old && !eqSet(c.old, old)) {
        return failAt(seq, null, 'phase',
          `日志下标 ${idx}: joint.old 与当前生效配置不一致`);
      }
      if (eqSet(c.new, old)) {
        return failAt(seq, null, 'phase', `日志下标 ${idx}: joint.new 与 old 完全相同，无成员变更`);
      }
      if (new Set(c.new).size !== c.new.length) {
        return failAt(seq, null, 'phase', `日志下标 ${idx}: joint.new 存在重复节点`);
      }
    }
    return null;
  }

  function updateCanonical(entry, idx, seq, ev) {
    const existing = canon[idx - 1];
    const establishes = !existing || existing.term < entry.term;
    if (establishes && idx <= commitIndex) {
      return { ...failAt(seq, ev, 'truncate',
        `参考日志下标 ${idx} 的已提交条目（任期 ${existing.term}）不得被任期 ${entry.term} 的条目覆盖，已提交项不可覆盖`),
        event: ev };
    }
    // 仅在未提交位置首次确立条目内容（领导者追加）时做配置阶段校验；
    // 副本事后补全已存在于参考日志的配置条目属于历史同步
    if (establishes && idx > commitIndex) {
      const err = admitConfig(entry, idx, seq);
      if (err) return { ...err, event: ev };
    }
    if (!existing) {
      canon[idx - 1] = clone(entry);
      const c = entry.config;
      if (c && c.kind === 'joint') c.new.forEach((n) => { if (!logs.has(n)) logs.set(n, []); });
    } else if (existing.term < entry.term) {
      canon.length = idx - 1;
      canon[idx - 1] = clone(entry);
      const c = entry.config;
      if (c && c.kind === 'joint') c.new.forEach((n) => { if (!logs.has(n)) logs.set(n, []); });
    }
    // 同任期条目内容必一致；更小任期忽略
    return null;
  }

  // --- 单事件 dry-run：复制事件先整体校验再落盘，保证失败原子性 ---
  function planReplicate(ev, seq) {
    const target = String(ev.target).trim();
    if (!logs.has(target)) logs.set(target, []); // 联合新节点首次出现
    const log = logs.get(target);
    if (ev.prevLogIndex > 0) {
      const prev = log[ev.prevLogIndex - 1];
      if (!prev || prev.term !== ev.prevLogTerm) {
        const reason = !prev
          ? `日志短于前驱下标 ${ev.prevLogIndex}（缺失该副本）`
          : `下标 ${ev.prevLogIndex} 任期为 ${prev.term}，与前驱任期 ${ev.prevLogTerm} 不匹配`;
        return { failure: failAt(seq, ev, 'predecessor',
          `复制到 ${target} 被拒：${reason}，按规则不得追加`,
          { target, prevLogIndex: ev.prevLogIndex, prevLogTerm: ev.prevLogTerm }) };
      }
    }
    let idx = ev.prevLogIndex;
    const plan = [];
    for (const entry of ev.entries) {
      idx += 1;
      const existing = log[idx - 1];
      if (existing && existing.term !== entry.term) {
        if (idx <= commitIndex) {
          return { failure: failAt(seq, ev, 'truncate',
            `复制到 ${target} 试图在日志下标 ${idx} 截断/覆盖已提交条目（全局提交下标 ${commitIndex}），已提交项不得覆盖`,
            { target, conflictIndex: idx, commitIndex }) };
        }
      }
      // joint 开启阶段校验：仅当该位置在参考日志中由本次复制首次确立、且尚未提交时；
      // 已存在于参考日志的配置条目是副本事后补全历史，不做阶段限制
      if (entry.config && entry.config.kind === 'joint') {
        const ref = canon[idx - 1];
        const establishes = !ref || ref.term < entry.term;
        if (establishes && idx > commitIndex) {
          const c = entry.config;
          if (phase.mode !== 'stable') {
            return { failure: failAt(seq, ev, 'phase',
              `日志下标 ${idx}: joint 只能在 stable 阶段开启，当前处于联合阶段`) };
          }
          if (c.old && !eqSet(c.old, phase.nodes)) {
            return { failure: failAt(seq, ev, 'phase',
              `日志下标 ${idx}: joint.old 与当前生效配置不一致`) };
          }
          if (eqSet(c.new, phase.nodes)) {
            return { failure: failAt(seq, ev, 'phase', `日志下标 ${idx}: joint.new 与 old 完全相同`) };
          }
        }
      }
      plan.push({ idx, entry });
    }
    return { target, log, plan };
  }

  function applyReplicate(ev, seq, planned) {
    let appended = 0;
    let truncatedFrom = null;
    let skipped = 0;
    const { target, log, plan } = planned;
    // 事务：失败时回滚目标日志、参考日志及新建副本，保证失败事件不落盘
    const savedLog = clone(log);
    const savedCanon = clone(canon);
    const savedKeys = [...logs.keys()];
    const rollback = () => {
      logs.set(target, savedLog);
      canon.length = 0;
      savedCanon.forEach((e, i) => { canon[i] = e; });
      for (const k of [...logs.keys()]) if (!savedKeys.includes(k)) logs.delete(k);
    };
    for (const { idx, entry } of plan) {
      const existing = log[idx - 1];
      if (existing) {
        if (existing.term === entry.term) { skipped += 1; }
        else {
          log.length = idx - 1;
          truncatedFrom = truncatedFrom === null ? idx : truncatedFrom;
        }
      }
      if (!log[idx - 1]) {
        log.push(clone(entry));
        appended += 1;
      }
      const cerr = updateCanonical(entry, idx, seq, ev);
      if (cerr) {
        rollback();
        return { failure: cerr };
      }
    }
    return { detail: { target, appended, skipped, truncatedFrom,
      prevLogIndex: ev.prevLogIndex, prevLogTerm: ev.prevLogTerm } };
  }

  function commitIndexCheck(k, seq, ev) {
    const ref = canon[k - 1];
    if (!ref) {
      return { failure: failAt(seq, ev, 'quorum',
        `下标 ${k} 在参考日志中尚不存在，无法提交`) };
    }
    let requirement;
    let switchToStable = null;

    if (ref.config && ref.config.kind === 'joint') {
      if (phase.mode !== 'stable') {
        return { failure: failAt(seq, ev, 'phase',
          `下标 ${k} 为 joint 配置，但当前已处于联合阶段，配置阶段错误`) };
      }
      const old = phase.nodes;
      const neu = ref.config.new;
      if (ref.config.old && !eqSet(ref.config.old, old)) {
        return { failure: failAt(seq, ev, 'phase', `下标 ${k}: joint.old 与生效配置不一致`) };
      }
      if (new Set(neu).size !== neu.length || eqSet(neu, old)) {
        return { failure: failAt(seq, ev, 'phase', `下标 ${k}: joint.new 非法`) };
      }
      requirement = { mode: 'joint', old, new: neu };
    } else if (ref.config && ref.config.kind === 'final') {
      if (phase.mode !== 'joint') {
        return { failure: failAt(seq, ev, 'phase',
          `下标 ${k} 为 final(${ref.config.nodes.join(',')}) 配置，但当前不在 joint 生效期间：` +
          `final(new) 只能在 joint(old,new) 提交之后、其生效期间提交`) };
      }
      if (!eqSet(ref.config.nodes, phase.new)) {
        return { failure: failAt(seq, ev, 'phase',
          `下标 ${k}: final 节点集合 {${ref.config.nodes.join(',')}} 与 joint 的 new 集合 {${phase.new.join(',')}} 不一致`) };
      }
      requirement = { mode: 'joint', old: phase.old, new: phase.new };
      switchToStable = ref.config.nodes;
    } else if (phase.mode === 'joint') {
      requirement = { mode: 'joint', old: phase.old, new: phase.new };
    } else {
      requirement = { mode: 'majority', nodes: phase.nodes };
    }

    const matchesAt = (n) => {
      const l = logs.get(n);
      return !!l && !!l[k - 1] && l[k - 1].term === ref.term;
    };
    const check = { index: k, term: ref.term, requirement: clone(requirement),
      configEntry: ref.config ? clone(ref.config) : null };

    if (requirement.mode === 'majority') {
      const matched = requirement.nodes.filter(matchesAt);
      const need = majority(requirement.nodes.length);
      check.need = need;
      check.matched = matched;
      check.missing = requirement.nodes.filter((n) => !matched.includes(n));
      if (matched.length < need) {
        return { failure: failAt(seq, ev, 'quorum',
          `提交下标 ${k}（任期 ${ref.term}）未达有效配置多数：需要 ${need}/${requirement.nodes.length}，` +
          `匹配副本 ${matched.length} 个 [${matched.join(', ') || '无'}]，` +
          `缺失 [${check.missing.join(', ')}]，不得以错误多数提交`,
          { check }) };
      }
    } else {
      const oldMatched = requirement.old.filter(matchesAt);
      const newMatched = requirement.new.filter(matchesAt);
      const oldNeed = majority(requirement.old.length);
      const newNeed = majority(requirement.new.length);
      check.oldNeed = oldNeed;
      check.newNeed = newNeed;
      check.oldMatched = oldMatched;
      check.newMatched = newMatched;
      check.oldMissing = requirement.old.filter((n) => !oldMatched.includes(n));
      check.newMissing = requirement.new.filter((n) => !newMatched.includes(n));
      check.matched = [...new Set([...oldMatched, ...newMatched])];
      if (oldMatched.length < oldNeed || newMatched.length < newNeed) {
        const parts = [];
        if (oldMatched.length < oldNeed) {
          parts.push(`旧集合需 ${oldNeed}/${requirement.old.length}，仅 [${oldMatched.join(', ') || '无'}] 匹配，缺 [${check.oldMissing.join(', ')}]`);
        }
        if (newMatched.length < newNeed) {
          parts.push(`新集合需 ${newNeed}/${requirement.new.length}，仅 [${newMatched.join(', ') || '无'}] 匹配，缺 [${check.newMissing.join(', ')}]`);
        }
        return { failure: failAt(seq, ev, 'quorum',
          `提交下标 ${k}（任期 ${ref.term}）处于联合阶段，须同时满足旧、新集合多数；${parts.join('；')}`,
          { check }) };
      }
    }

    return { check, switchToStable };
  }

  // --- 按序回放 ---
  const snapshots = [];
  for (let i = 0; i < events.length; i += 1) {
    const seq = i + 1;
    const ev = events[i];

    if (ev.type === 'replicate') {
      const planned = planReplicate(ev, seq);
      if (planned.failure) return { ok: false, snapshots, failure: planned.failure };
      const r = applyReplicate(ev, seq, planned);
      if (r.failure) return { ok: false, snapshots, failure: r.failure };
      snapshots.push(snapshot(seq, ev, r.detail));
    } else {
      if (!isInt(ev.index) || ev.index < commitIndex) {
        return { ok: false, snapshots, failure: failAt(seq, ev, 'phase',
          `commit 下标 ${ev.index} 非法或小于已提交下标 ${commitIndex}`) };
      }
      const checks = [];
      for (let k = commitIndex + 1; k <= ev.index; k += 1) {
        const r = commitIndexCheck(k, seq, ev);
        if (r.failure) {
          r.failure.checks = checks;
          return { ok: false, snapshots, failure: r.failure };
        }
        checks.push(r.check);
        commitIndex = k;
        if (r.switchToStable) {
          phase = { mode: 'stable', nodes: r.switchToStable };
        } else if (r.check.configEntry && r.check.configEntry.kind === 'joint') {
          phase = { mode: 'joint', old: r.check.requirement.old, new: r.check.requirement.new };
        }
      }
      const last = checks[checks.length - 1];
      snapshots.push(snapshot(seq, ev, {
        targetIndex: ev.index,
        checks,
        quorumNodes: last ? last.matched : [],
      }));
    }
  }

  return { ok: true, snapshots, failure: null };
}
