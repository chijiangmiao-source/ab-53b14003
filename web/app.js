// 浏览器端：轨迹录入表单 <-> JSON 互转，调用 engine.replay，逐事件渲染快照
import { replay } from './engine.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- 示例场景 ----------
// 3 节点加 d：先 joint(1) 再 final(2)
const EXAMPLES = {
  happy3to4: {
    nodes: ['n1', 'n2', 'n3'],
    events: [
      { type: 'replicate', target: 'n1', prevLogIndex: 0, prevLogTerm: 0,
        entries: [{ term: 1, config: { kind: 'joint', new: ['n1', 'n2', 'n3', 'd'] } }] },
      { type: 'replicate', target: 'n2', prevLogIndex: 0, prevLogTerm: 0,
        entries: [{ term: 1, config: { kind: 'joint', new: ['n1', 'n2', 'n3', 'd'] } }] },
      { type: 'replicate', target: 'd', prevLogIndex: 0, prevLogTerm: 0,
        entries: [{ term: 1, config: { kind: 'joint', new: ['n1', 'n2', 'n3', 'd'] } }] },
      { type: 'commit', index: 1 },
      { type: 'replicate', target: 'n1', prevLogIndex: 1, prevLogTerm: 1,
        entries: [{ term: 1, config: { kind: 'final', nodes: ['n1', 'n2', 'n3', 'd'] } }] },
      { type: 'replicate', target: 'n2', prevLogIndex: 1, prevLogTerm: 1,
        entries: [{ term: 1, config: { kind: 'final', nodes: ['n1', 'n2', 'n3', 'd'] } }] },
      { type: 'replicate', target: 'd', prevLogIndex: 1, prevLogTerm: 1,
        entries: [{ term: 1, config: { kind: 'final', nodes: ['n1', 'n2', 'n3', 'd'] } }] },
      { type: 'commit', index: 2 },
    ],
  },
  oldquorum: {
    // joint 只复制到 n1 + d：旧集合 {n1,n2,n3} 仅 n1 匹配（需 2）-> 联合多数失败
    nodes: ['n1', 'n2', 'n3'],
    events: [
      { type: 'replicate', target: 'n1', prevLogIndex: 0, prevLogTerm: 0,
        entries: [{ term: 1, config: { kind: 'joint', new: ['n1', 'n2', 'n3', 'd'] } }] },
      { type: 'replicate', target: 'd', prevLogIndex: 0, prevLogTerm: 0,
        entries: [{ term: 1, config: { kind: 'joint', new: ['n1', 'n2', 'n3', 'd'] } }] },
      { type: 'commit', index: 1 },
    ],
  },
  newquorum: {
    // joint 复制到 n1,n2 但新集合只有 n1 有（需 2/4）-> 新集合多数失败
    nodes: ['n1', 'n2', 'n3'],
    events: [
      { type: 'replicate', target: 'n1', prevLogIndex: 0, prevLogTerm: 0,
        entries: [{ term: 1, config: { kind: 'joint', new: ['n1', 'n2', 'n3', 'd'] } }] },
      { type: 'replicate', target: 'n2', prevLogIndex: 0, prevLogTerm: 0,
        entries: [{ term: 1, config: { kind: 'joint', new: ['n1', 'n2', 'n3', 'd'] } }] },
      { type: 'commit', index: 1 },
    ],
  },
  finalbefore: {
    // 未先提交 joint 就提交 final -> 配置阶段失败
    nodes: ['n1', 'n2', 'n3'],
    events: [
      { type: 'replicate', target: 'n1', prevLogIndex: 0, prevLogTerm: 0,
        entries: [{ term: 1, config: { kind: 'final', nodes: ['n1', 'n2', 'n3', 'd'] } }] },
      { type: 'replicate', target: 'n2', prevLogIndex: 0, prevLogTerm: 0,
        entries: [{ term: 1, config: { kind: 'final', nodes: ['n1', 'n2', 'n3', 'd'] } }] },
      { type: 'commit', index: 1 },
    ],
  },
  prevmismatch: {
    nodes: ['n1', 'n2', 'n3'],
    events: [
      { type: 'replicate', target: 'n1', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'replicate', target: 'n2', prevLogIndex: 1, prevLogTerm: 2, entries: [{ term: 2 }] },
    ],
  },
  committedtrunc: {
    // 下标 1 已提交后，向 n2 发送 term2 的下标 1 覆盖 -> 非法截断
    nodes: ['n1', 'n2', 'n3'],
    events: [
      { type: 'replicate', target: 'n1', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'replicate', target: 'n2', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'commit', index: 1 },
      { type: 'replicate', target: 'n2', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 2 }] },
    ],
  },
};

// ---------- 表单状态 ----------
let uiEvents = [];

function newReplEvent() {
  return { type: 'replicate', target: '', prevLogIndex: 0, prevLogTerm: 0,
    entries: [{ term: 1 }] };
}
function newCommitEvent() { return { type: 'commit', index: 1 }; }

function renderEditor() {
  const box = $('#event-editor');
  box.innerHTML = '';
  uiEvents.forEach((ev, i) => {
    const card = document.createElement('div');
    card.className = 'event-card';

    const head = document.createElement('div');
    head.className = 'event-head';
    head.innerHTML = `<span class="seq">#${i + 1}</span>`;
    const typeSel = document.createElement('select');
    ['replicate', 'commit'].forEach((t) => {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t === 'replicate' ? '复制 replicate' : '提交 commit';
      if (ev.type === t) o.selected = true;
      typeSel.appendChild(o);
    });
    typeSel.addEventListener('change', () => {
      uiEvents[i] = typeSel.value === 'replicate' ? newReplEvent() : newCommitEvent();
      renderEditor();
    });
    head.appendChild(typeSel);

    const del = document.createElement('button');
    del.className = 'danger mini';
    del.textContent = '删除';
    del.addEventListener('click', () => { uiEvents.splice(i, 1); renderEditor(); });
    head.appendChild(del);

    const up = document.createElement('button');
    up.className = 'mini';
    up.textContent = '↑';
    up.disabled = i === 0;
    up.addEventListener('click', () => {
      [uiEvents[i - 1], uiEvents[i]] = [uiEvents[i], uiEvents[i - 1]];
      renderEditor();
    });
    head.appendChild(up);
    const down = document.createElement('button');
    down.className = 'mini';
    down.textContent = '↓';
    down.disabled = i === uiEvents.length - 1;
    down.addEventListener('click', () => {
      [uiEvents[i + 1], uiEvents[i]] = [uiEvents[i], uiEvents[i + 1]];
      renderEditor();
    });
    head.appendChild(down);
    card.appendChild(head);

    const fields = document.createElement('div');
    fields.className = 'event-fields';

    if (ev.type === 'replicate') {
      fields.appendChild(textField(ev, 'target', '目标节点', 'wide'));
      fields.appendChild(numField(ev, 'prevLogIndex', '前驱索引', 0));
      fields.appendChild(numField(ev, 'prevLogTerm', '前驱任期', 0));
      card.appendChild(fields);

      const entries = document.createElement('div');
      entries.className = 'entries';
      const label = document.createElement('div');
      label.className = 'tag';
      label.textContent = '连续日志项（可标记 joint / final 配置，留空为普通条目）';
      label.style.color = '#7d92b3';
      label.style.fontSize = '12px';
      label.style.marginBottom = '6px';
      entries.appendChild(label);

      ev.entries.forEach((entry, j) => {
        const row = document.createElement('div');
        row.className = 'entry-row';
        const t = document.createElement('input');
        t.type = 'number'; t.min = '1'; t.value = entry.term;
        t.title = '任期 term';
        t.placeholder = 'term';
        t.addEventListener('input', () => { entry.term = Number(t.value); });
        row.appendChild(withTag(t, `第${j + 1}项 term`));

        const cfg = document.createElement('select');
        [['none', '普通条目'], ['joint', 'joint(old,new)'], ['final', 'final(new)']].forEach(([v, txt]) => {
          const o = document.createElement('option');
          o.value = v; o.textContent = txt;
          const cur = entry.config ? entry.config.kind : 'none';
          if (cur === v) o.selected = true;
          cfg.appendChild(o);
        });
        cfg.addEventListener('change', () => {
          if (cfg.value === 'joint') entry.config = { kind: 'joint', new: [] };
          else if (cfg.value === 'final') entry.config = { kind: 'final', nodes: [] };
          else delete entry.config;
          renderEditor();
        });
        row.appendChild(cfg);

        if (entry.config) {
          const nodesTxt = document.createElement('input');
          nodesTxt.type = 'text';
          nodesTxt.placeholder = entry.config.kind === 'joint' ? '新集合 new，逗号分隔（old 自动取当前配置）' : 'final 节点集合，逗号分隔';
          nodesTxt.value = (entry.config.new || entry.config.nodes || []).join(',');
          nodesTxt.style.width = '320px';
          nodesTxt.addEventListener('input', () => {
            const arr = nodesTxt.value.split(',').map((s) => s.trim()).filter(Boolean);
            if (entry.config.kind === 'joint') entry.config.new = arr;
            else entry.config.nodes = arr;
          });
          row.appendChild(nodesTxt);
        }

        if (ev.entries.length > 1) {
          const rm = document.createElement('button');
          rm.className = 'danger mini';
          rm.textContent = '移除该项';
          rm.addEventListener('click', () => { ev.entries.splice(j, 1); renderEditor(); });
          row.appendChild(rm);
        }
        entries.appendChild(row);
      });

      const addEntry = document.createElement('button');
      addEntry.className = 'mini';
      addEntry.textContent = '+ 追加一项连续日志';
      addEntry.addEventListener('click', () => { ev.entries.push({ term: 1 }); renderEditor(); });
      entries.appendChild(addEntry);
      card.appendChild(entries);
    } else {
      fields.appendChild(numField(ev, 'index', '提交到下标 commitIndex', 1));
      card.appendChild(fields);
    }

    box.appendChild(card);
  });
  updateCounters();
}

function withTag(input, text) {
  const wrap = document.createElement('label');
  wrap.style.fontSize = '12px';
  wrap.appendChild(document.createTextNode(text));
  wrap.appendChild(input);
  return wrap;
}
function textField(obj, key, label, cls) {
  const wrap = document.createElement('label');
  wrap.textContent = label;
  const inp = document.createElement('input');
  inp.type = 'text';
  if (cls) inp.className = cls;
  inp.value = obj[key];
  inp.addEventListener('input', () => { obj[key] = inp.value.trim(); });
  wrap.appendChild(inp);
  return wrap;
}
function numField(obj, key, label, min) {
  const wrap = document.createElement('label');
  wrap.textContent = label;
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.min = String(min);
  inp.value = obj[key];
  inp.addEventListener('input', () => { obj[key] = Number(inp.value); });
  wrap.appendChild(inp);
  return wrap;
}

function updateCounters() {
  let joints = 0;
  uiEvents.forEach((e) => {
    if (e.type === 'replicate') {
      (e.entries || []).forEach((x) => { if (x.config && x.config.kind === 'joint') joints += 1; });
    }
  });
  $('#cnt-changes').textContent = String(joints);
  $('#cnt-events').textContent = String(uiEvents.length);
}

function collectInput() {
  return {
    nodes: $('#nodes-input').value.split(',').map((s) => s.trim()).filter(Boolean),
    events: JSON.parse(JSON.stringify(uiEvents)),
  };
}
function loadInput(input) {
  $('#nodes-input').value = (input.nodes || []).join(',');
  uiEvents = (input.events || []).map((e) => JSON.parse(JSON.stringify(e)));
  renderEditor();
}

// ---------- 结果渲染 ----------
const CAT_LABEL = {
  predecessor: '前驱不匹配 / 缺失匹配副本',
  truncate: '非法截断（覆盖已提交项）',
  phase: '错误配置阶段',
  quorum: '未取得有效配置多数',
  input: '录入不合法',
};

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function phaseBadge(phase) {
  if (phase.mode === 'stable') {
    return `<span class="badge stable">生效配置: stable {${esc(phase.nodes.join(', '))}}</span>`;
  }
  return `<span class="badge joint">生效配置: joint old{${esc(phase.old.join(', '))}} + new{${esc(phase.new.join(', '))}}</span>`;
}
function logCell(rep) {
  if (!rep.tail.length) return '<span style="color:#5d7292">∅</span>';
  const startIdx = rep.tail[0].index;
  return rep.tail.map((e) => {
    let cls = 'le';
    let txt = `${e.index}:t${e.term}`;
    if (e.config && e.config.kind === 'joint') { cls += ' jc'; txt += ' J'; }
    if (e.config && e.config.kind === 'final') { cls += ' fn'; txt += ' F'; }
    if (!rep.active) cls += ' inactive';
    return `<span class="${cls}" title="下标${e.index} 任期${e.term}${e.config ? ' ' + e.config.kind : ''}">${esc(txt)}</span>`;
  }).join(' ') + (startIdx > 1 ? ` <span class="tag" style="color:#5d7292">(前 ${startIdx - 1} 项已折叠)</span>` : '');
}

function renderSnapshots(result) {
  const tl = $('#timeline');
  tl.innerHTML = '';

  result.snapshots.forEach((s) => {
    const div = document.createElement('div');
    div.className = 'snap ok';
    let head = '';
    if (s.type === 'replicate') {
      const d = s.detail;
      head = `事件 #${s.seq} 复制 → ${esc(d.target)}：前驱(${d.prevLogIndex}, t${d.prevLogTerm})匹配，` +
        `追加 ${d.appended} 项` +
        (d.skipped ? `，相同任期跳过 ${d.skipped} 项` : '') +
        (d.truncatedFrom !== null ? `，自下标 ${d.truncatedFrom} 截断未提交尾部` : '');
    } else {
      const d = s.detail;
      const last = d.checks[d.checks.length - 1];
      const qnodes = (last && last.matched || []).join(', ');
      head = `事件 #${s.seq} 提交至下标 ${d.targetIndex}：构成多数的节点 [${esc(qnodes)}]`;
    }
    const rows = s.replicas.map((r) => `
      <tr>
        <td>${esc(r.node)}${r.active ? '' : ' <span class="tag" style="color:#8a7435">(非当前投票成员)</span>'}</td>
        <td>${r.length}</td>
        <td class="logcell">${logCell(r)}</td>
      </tr>`).join('');
    div.innerHTML = `
      <h3>${esc(head)}</h3>
      <div class="badges">
        <span class="badge commit">已提交索引 commitIndex = ${s.commitIndex}</span>
        ${phaseBadge(s.phase)}
      </div>
      <table class="replicas">
        <thead><tr><th>副本</th><th>日志长度</th><th>日志末尾（尾部条目，J=joint, F=final）</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    tl.appendChild(div);
  });

  if (result.failure) {
    const f = result.failure;
    const div = document.createElement('div');
    div.className = 'snap fail';
    const rows = f.replicas.map((r) => `
      <tr>
        <td>${esc(r.node)}${r.active ? '' : ' <span class="tag" style="color:#8a7435">(非当前投票成员)</span>'}</td>
        <td>${r.length}</td>
        <td class="logcell">${logCell(r)}</td>
      </tr>`).join('');
    let checks = '';
    if (f.check && f.check.requirement) {
      const c = f.check;
      if (c.requirement.mode === 'joint') {
        checks = `<div class="hint" style="margin-top:6px">
          旧集合 {${esc(c.requirement.old.join(', '))}} 需 ${c.oldNeed}，匹配 [${esc(c.oldMatched.join(', '))}]，缺失 [${esc(c.oldMissing.join(', '))}]<br/>
          新集合 {${esc(c.requirement.new.join(', '))}} 需 ${c.newNeed}，匹配 [${esc(c.newMatched.join(', '))}]，缺失 [${esc(c.newMissing.join(', '))}]</div>`;
      } else {
        checks = `<div class="hint" style="margin-top:6px">
          配置 {${esc(c.requirement.nodes.join(', '))}} 需多数 ${c.need}，匹配 [${esc(c.matched.join(', '))}]，缺失 [${esc(c.missing.join(', '))}]</div>`;
      }
    }
    div.innerHTML = `
      <h3>⛔ 事件 #${f.eventSeq} 首次失败（状态未改变，以下为此前快照）</h3>
      <div class="badges">
        <span class="badge fail-badge">失败分类：${esc(CAT_LABEL[f.category] || f.category)}</span>
        <span class="badge commit">已提交索引 commitIndex = ${f.commitIndex}</span>
        ${phaseBadge(f.phase)}
      </div>
      <div class="fail-detail"><span class="cat">定位：</span>${esc(f.message)}</div>
      ${checks}
      <table class="replicas" style="margin-top:8px">
        <thead><tr><th>副本</th><th>日志长度</th><th>日志末尾</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    tl.appendChild(div);
  }
}

function run() {
  const errBox = $('#input-error');
  errBox.classList.add('hidden');
  let input;
  try {
    input = collectInput();
  } catch (e) {
    errBox.textContent = '表单数据异常: ' + e.message;
    errBox.classList.remove('hidden');
    return;
  }
  const result = replay(input);
  const summary = $('#result-summary');
  if (result.inputError) {
    summary.innerHTML = `<span class="summary-fail">录入不合法：${esc(result.inputError.message)}</span>`;
    $('#timeline').innerHTML = '';
    return;
  }
  if (result.ok) {
    summary.innerHTML = `<span class="summary-ok">✔ 全部 ${result.snapshots.length} 个事件回放通过：未发现错误多数提交、非法截断或错误配置阶段。</span>`;
  } else {
    const f = result.failure;
    summary.innerHTML = `<span class="summary-fail">✘ 回放于事件 #${f.eventSeq} 首次失败：${esc(CAT_LABEL[f.category] || f.category)}。此前 ${result.snapshots.length} 个事件快照已保留。</span>`;
  }
  renderSnapshots(result);
}

// ---------- 绑定 ----------
$('#btn-add-repl').addEventListener('click', () => { uiEvents.push(newReplEvent()); renderEditor(); });
$('#btn-add-commit').addEventListener('click', () => { uiEvents.push(newCommitEvent()); renderEditor(); });
$('#btn-run').addEventListener('click', run);
$('#nodes-input').addEventListener('input', updateCounters);

$('#btn-json').addEventListener('click', () => {
  const panel = $('#json-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    $('#json-text').value = JSON.stringify(collectInput(), null, 2);
  }
});
$('#btn-json-sync').addEventListener('click', () => {
  $('#json-text').value = JSON.stringify(collectInput(), null, 2);
});
$('#btn-json-apply').addEventListener('click', () => {
  const errBox = $('#input-error');
  try {
    const obj = JSON.parse($('#json-text').value);
    loadInput(obj);
    errBox.classList.add('hidden');
  } catch (e) {
    errBox.textContent = 'JSON 解析失败: ' + e.message;
    errBox.classList.remove('hidden');
  }
});

$$('[data-example]').forEach((btn) => {
  btn.addEventListener('click', () => {
    loadInput(EXAMPLES[btn.dataset.example]);
    run();
  });
});

// 初始载入：正确变更示例
loadInput(EXAMPLES.happy3to4);
run();
