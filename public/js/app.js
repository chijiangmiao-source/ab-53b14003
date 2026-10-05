import { replayEvents, LIMITS } from './raft.js';

const $ = (sel) => document.querySelector(sel);

let rows = []; // { kind: 'replicate'|'commit', el, fields... }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function field(label, cls, attrs) {
  return `<label>${label}<input class="${cls}" ${attrs} /></label>`;
}

function makeRow(spec = {}) {
  const li = document.createElement('li');
  li.className = 'event-row';
  const kind = spec.kind === 'commit' ? 'commit' : 'replicate';

  if (kind === 'commit') {
    li.innerHTML = `
      <div class="event-head">
        <span class="seq"></span><span class="tag commit">提交 COMMIT</span>
        <span class="ops">
          <button type="button" data-act="up" title="上移">↑</button>
          <button type="button" data-act="down" title="下移">↓</button>
          <button type="button" data-act="del" class="danger" title="删除">✕</button>
        </span>
      </div>
      <div class="event-fields">${field('提交至索引', 'f-index', 'type="number" min="1" step="1"')}</div>`;
    li.querySelector('.f-index').value = spec.index ?? 1;
  } else {
    const entry = spec.entries?.[0] ?? {};
    li.innerHTML = `
      <div class="event-head">
        <span class="seq"></span><span class="tag replicate">复制 APPEND</span>
        <span class="ops">
          <button type="button" data-act="up" title="上移">↑</button>
          <button type="button" data-act="down" title="下移">↓</button>
          <button type="button" data-act="del" class="danger" title="删除">✕</button>
        </span>
      </div>
      <div class="event-fields">
        ${field('目标节点', 'f-target', 'type="text" spellcheck="false"')}
        ${field('前驱索引', 'f-previndex', 'type="number" min="0" step="1"')}
        ${field('前驱任期', 'f-prevterm', 'type="number" min="0" step="1"')}
        <button type="button" data-act="add-entry" class="ghost">+ 连续项</button>
      </div>
      <div class="entries"></div>`;
    li.querySelector('.f-target').value = spec.target ?? '';
    li.querySelector('.f-previndex').value = spec.prevLogIndex ?? 0;
    li.querySelector('.f-prevterm').value = spec.prevLogTerm ?? 0;
    const entriesWrap = li.querySelector('.entries');
    const specs = spec.entries?.length ? spec.entries : [entry];
    specs.forEach(() => addEntryLine(entriesWrap, entry));
  }
  return li;
}

function addEntryLine(wrap, data = {}) {
  const line = document.createElement('div');
  line.className = 'entry-line';
  line.innerHTML = `
    ${field('任期', 'e-term', 'type="number" min="0" step="1" style="width:72px"')}
    <label>类型
      <select class="e-kind">
        <option value="cmd">指令</option>
        <option value="joint">joint(old,new)</option>
        <option value="final">final(new)</option>
      </select>
    </label>
    <label class="l-cmd">内容<input class="e-payload" type="text" placeholder="指令内容" /></label>
    <label class="l-peers hidden">新集合（逗号/空格分隔）<input class="e-peers" type="text" spellcheck="false" placeholder="A,B,C,D" /></label>
    <button type="button" data-act="del-entry" class="ghost danger" title="删除该项">✕</button>`;
  line.querySelector('.e-term').value = data.term ?? 1;
  line.querySelector('.e-kind').value = data.kind ?? 'cmd';
  line.querySelector('.e-payload').value = data.payload ?? '';
  line.querySelector('.e-peers').value = Array.isArray(data.peers) ? data.peers.join(', ') : data.peers ?? '';
  syncEntryLine(line);
  line.querySelector('.e-kind').addEventListener('change', () => syncEntryLine(line));
  wrap.appendChild(line);
}

function syncEntryLine(line) {
  const isCfg = line.querySelector('.e-kind').value !== 'cmd';
  line.querySelector('.l-cmd').classList.toggle('hidden', isCfg);
  line.querySelector('.l-peers').classList.toggle('hidden', !isCfg);
}

function renumber() {
  rows.forEach((r, i) => {
    const seq = r.el.querySelector('.seq');
    if (seq) seq.textContent = `#${i + 1}`;
  });
  $('#event-hint').textContent = rows.length
    ? `已录入 ${rows.length} 项（上限 ${LIMITS.MAX_EVENTS}）`
    : '';
}

function addRow(spec) {
  if (rows.length >= LIMITS.MAX_EVENTS) return;
  const el = makeRow(spec);
  $('#event-list').appendChild(el);
  rows.push({ kind: el.querySelector('.tag').classList.contains('commit') ? 'commit' : 'replicate', el });
  renumber();
}

function collectInput() {
  const peers = $('#initial-peers').value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  const events = [];
  for (const r of rows) {
    if (r.kind === 'commit') {
      events.push({ type: 'commit', index: Number(r.el.querySelector('.f-index').value) });
    } else {
      const entries = [...r.el.querySelectorAll('.entry-line')].map((line) => {
        const kind = line.querySelector('.e-kind').value;
        const e = { term: Number(line.querySelector('.e-term').value), kind };
        if (kind === 'cmd') e.payload = line.querySelector('.e-payload').value;
        else e.peers = line.querySelector('.e-peers').value;
        return e;
      });
      events.push({
        type: 'replicate',
        target: r.el.querySelector('.f-target').value,
        prevLogIndex: Number(r.el.querySelector('.f-previndex').value),
        prevLogTerm: Number(r.el.querySelector('.f-prevterm').value),
        entries,
      });
    }
  }
  return { peers, events };
}

function configText(cfg) {
  return cfg.map((c) => {
    const label = c.role === 'old' ? '旧集合' : c.role === 'new' ? '新集合' : '配置';
    return `${label}{${c.peers.join(',')}}`;
  }).join(' ∩ ');
}

function renderQuorum(checks) {
  const rowsHtml = checks
    .map((q) => {
      const groups = q.sets
        .map((s) => {
          const label = s.role === 'old' ? '旧' : s.role === 'new' ? '新' : '配置';
          return `<td>${label}{${esc(s.set.join(','))}}</td>
            <td>${s.voters.length}/${s.size}（需${s.need}）</td>
            <td class="${s.satisfied ? 'yes' : 'no'}">${s.satisfied ? '✔' : '✘'} ${esc(s.voters.join(',') || '—')}</td>`;
        })
        .join('</tr><tr>');
      const kind = q.kind === 'cmd' ? '指令' : q.kind;
      return `<tr><td rowspan="${q.sets.length}">#${q.index} ${esc(kind)} t${q.term}</td>${groups}</tr>`;
    })
    .join('');
  return `<div class="quorum"><table>
    <tr><th>提交项</th><th>集合</th><th>匹配/多数</th><th>构成多数的节点</th></tr>
    ${rowsHtml}</table></div>`;
}

function renderSnapshot(snap) {
  const replicas = snap.replicas
    .map((r) => {
      const chips = r.log
        .map((e) => {
          const committed = e.index <= r.commitIndex ? ' committed' : '';
          const kindCls = e.kind && e.kind !== 'cmd' ? ` kind-${e.kind}` : '';
          const body = e.kind === 'joint'
            ? `joint→{${esc((e.peers || []).join(','))}}`
            : e.kind === 'final'
              ? `final→{${esc((e.peers || []).join(','))}}`
              : `<span class="payload">${esc(e.payload)}</span>`;
          return `<span class="chip${committed}${kindCls}" title="索引 ${e.index}">${e.index}:t${e.term} ${body}</span>`;
        })
        .join('');
      return `<div class="replica">
        <div class="name">${esc(r.peer)}</div>
        <div class="meta">本地已确认提交索引：${r.commitIndex}</div>
        <div class="logline">${chips || '<span class="meta">（空日志）</span>'}</div>
      </div>`;
    })
    .join('');

  const extra = snap.commit
    ? renderQuorum(snap.commit.quorumChecks)
    : snap.replicate
      ? `<div class="quorum"><table><tr><th>复制结果</th></tr><tr><td>追加/对齐 ${snap.replicate.appended} 项到 ${esc(snap.replicate.target)}（前驱 ${snap.replicate.prevLogIndex}/t${snap.replicate.prevLogTerm}）</td></tr></table></div>`
      : '';

  return `<div class="snapshot">
    <div class="snap-head">
      <span class="seq">事件 #${snap.seq}</span>
      <span class="tag ${snap.eventType}">${snap.eventType === 'commit' ? '提交' : '复制'}</span>
      <span>全局已提交索引：<b>${snap.commitIndex}</b></span>
      <span class="phase-${snap.phase}">阶段：${snap.phase === 'joint' ? '联合 joint(old,new)' : '稳定'}</span>
      <span class="hint">有效配置：${esc(configText(snap.config))}</span>
    </div>
    ${extra}
    <div class="replicas">${replicas}</div>
  </div>`;
}

function run() {
  const { peers, events } = collectInput();
  const result = replayEvents(peers, events);
  $('#result-section').classList.remove('hidden');
  $('#setup-error').classList.add('hidden');
  $('#failure-panel').classList.add('hidden');
  $('#success-panel').classList.add('hidden');

  if (result.setupError) {
    $('#setup-error').innerHTML = `录入无效：<span class="code">${esc(result.setupError.code)}</span> — ${esc(result.setupError.message)}`;
    $('#setup-error').classList.remove('hidden');
    $('#snapshots').innerHTML = '';
    return;
  }

  $('#snapshots').innerHTML = result.snapshots.map(renderSnapshot).join('');

  if (result.error) {
    const e = result.error;
    const evText = e.event.type === 'commit'
      ? `提交至索引 ${e.event.index}`
      : `复制到 ${e.event.target}（前驱 ${e.event.prevLogIndex}/t${e.event.prevLogTerm}，${e.event.entries.length} 项）`;
    let detail = '';
    if (e.code === 'QUORUM_FAILED') {
      detail = `缺失匹配副本：${esc((e.evidence.missing || []).join(', ') || '无')}；` +
        `需要 ${e.evidence.checks.map((c) => `${c.role === 'old' ? '旧' : c.role === 'new' ? '新' : '配置'}${c.voters.length}/${c.need}`).join('，')}`;
    } else if (e.code === 'ILLEGAL_OVERWRITE') {
      detail = `非法截断/覆盖位置：节点 ${esc(e.evidence.target)} 索引 ${e.evidence.index}（已提交 t${e.evidence.committedTerm}）`;
    }
    $('#failure-panel').innerHTML =
      `🛑 首次失败于事件 #${e.seq}（${esc(evText)}）：<span class="code">${esc(e.code)}</span><br>${esc(e.message)}` +
      (detail ? `<br><span class="hint">${detail}</span>` : '') +
      `<br><span class="hint">已保留此前 ${result.snapshots.length} 个事件快照。</span>`;
    $('#failure-panel').classList.remove('hidden');
  } else {
    $('#success-panel').textContent = `✔ 全部 ${result.snapshots.length} 项事件回放通过：每次提交均由匹配索引的副本取得当时有效配置所需多数，成员变更阶段合法。`;
    $('#success-panel').classList.remove('hidden');
  }
  $('#result-section').scrollIntoView({ behavior: 'smooth' });
}

const PRESETS = {
  ok: {
    peers: 'A, B, C',
    events: [
      { type: 'replicate', target: 'A', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1, kind: 'cmd', payload: 'set x=1' }] },
      { type: 'replicate', target: 'B', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1, kind: 'cmd', payload: 'set x=1' }] },
      { type: 'commit', index: 1 },
      { type: 'replicate', target: 'A', prevLogIndex: 1, prevLogTerm: 1, entries: [{ term: 2, kind: 'joint', peers: 'A,B,D' }] },
      { type: 'replicate', target: 'B', prevLogIndex: 1, prevLogTerm: 1, entries: [{ term: 2, kind: 'joint', peers: 'A,B,D' }] },
      { type: 'replicate', target: 'D', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1, kind: 'cmd', payload: 'set x=1' }, { term: 2, kind: 'joint', peers: 'A,B,D' }] },
      { type: 'commit', index: 2 },
      { type: 'replicate', target: 'A', prevLogIndex: 2, prevLogTerm: 2, entries: [{ term: 2, kind: 'final', peers: 'A,B,D' }] },
      { type: 'replicate', target: 'B', prevLogIndex: 2, prevLogTerm: 2, entries: [{ term: 2, kind: 'final', peers: 'A,B,D' }] },
      { type: 'replicate', target: 'D', prevLogIndex: 2, prevLogTerm: 2, entries: [{ term: 2, kind: 'final', peers: 'A,B,D' }] },
      { type: 'commit', index: 3 },
    ],
  },
  'joint-quorum': {
    peers: 'A, B, C',
    events: [
      { type: 'replicate', target: 'A', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1, kind: 'joint', peers: 'A,B,C,D' }] },
      { type: 'replicate', target: 'B', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1, kind: 'joint', peers: 'A,B,C,D' }] },
      // 旧集合多数满足（A,B），新集合仅 A,B 且 D 缺失，新集合 4 节点需 3，失败
      { type: 'commit', index: 1 },
    ],
  },
  'final-phase': {
    peers: 'A, B, C',
    events: [
      { type: 'replicate', target: 'A', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1, kind: 'final', peers: 'A,B,D' }] },
      { type: 'replicate', target: 'B', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1, kind: 'final', peers: 'A,B,D' }] },
      { type: 'replicate', target: 'D', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1, kind: 'final', peers: 'A,B,D' }] },
      { type: 'commit', index: 1 }, // joint 未生效，非法
    ],
  },
  truncate: {
    peers: 'A, B, C',
    events: [
      { type: 'replicate', target: 'A', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1, kind: 'cmd', payload: 'x=1' }] },
      { type: 'replicate', target: 'B', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1, kind: 'cmd', payload: 'x=1' }] },
      { type: 'commit', index: 1 },
      { type: 'replicate', target: 'B', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 2, kind: 'cmd', payload: 'x=2' }] }, // 覆盖已提交索引1
    ],
  },
};

function loadPreset(key) {
  const p = PRESETS[key];
  if (!p) return;
  $('#initial-peers').value = p.peers;
  $('#event-list').innerHTML = '';
  rows = [];
  p.events.forEach((e) => addRow(e));
}

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const rowEl = btn.closest('.event-row');
  const idx = rows.findIndex((r) => r.el === rowEl);
  const act = btn.dataset.act;
  if (act === 'del' && idx >= 0) {
    rowEl.remove();
    rows.splice(idx, 1);
    renumber();
  } else if ((act === 'up' || act === 'down') && idx >= 0) {
    const swap = act === 'up' ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= rows.length) return;
    const list = $('#event-list');
    const moving = act === 'up' ? rowEl : rowEl.nextSibling;
    list.insertBefore(rows[swap].el === moving ? rowEl : rows[swap].el, moving ?? null);
    [rows[idx], rows[swap]] = [rows[swap], rows[idx]];
    renumber();
  } else if (act === 'add-entry' && rowEl) {
    addEntryLine(rowEl.querySelector('.entries'));
  } else if (act === 'del-entry') {
    const wrap = btn.closest('.entries');
    if (wrap.querySelectorAll('.entry-line').length > 1) btn.closest('.entry-line').remove();
  }
});

$('#add-repl').addEventListener('click', () => addRow({ kind: 'replicate', entries: [{ term: 1, kind: 'cmd' }] }));
$('#add-commit').addEventListener('click', () => addRow({ kind: 'commit', index: 1 }));
$('#btn-run').addEventListener('click', run);
$('#btn-clear').addEventListener('click', () => {
  $('#event-list').innerHTML = '';
  rows = [];
  renumber();
  $('#result-section').classList.add('hidden');
});
$('#preset').addEventListener('change', (e) => {
  loadPreset(e.target.value);
});

loadPreset('ok');
