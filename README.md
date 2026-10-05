# 飞控冗余集群 · 复制与提交轨迹复核

审查员复核捕获的复制（AppendEntries）与提交轨迹，确认成员变更期间没有以错误多数提交指令。
纯浏览器内回放，零运行时依赖（Node ≥ 18 仅用于静态服务与验收）。

## 复核规则

- 初始节点 3–5 个；成员变更（joint+final 计一次）至多两次；事件至多 48 项，按序回放。
- **复制事件**（目标节点、前驱索引、前驱任期、连续日志项）：
  - 仅在目标节点的前驱索引处日志存在且任期匹配时生效；
  - 冲突时只能截断未提交尾部后追加；已提交项不得覆盖（报 `ILLEGAL_OVERWRITE`）；
  - 前驱缺失/任期不符报 `PREV_MISMATCH`，日志保持不变。
- **成员变更**：
  - 必须先提交 `joint(old,new)`，且该次提交同时取得旧集合与新集合的多数；
  - joint 生效期间（联合阶段）的每次提交（含普通指令）都必须同时满足旧、新集合多数；
  - `final(new)` 只能在联合阶段提交，且 new 必须与 joint 声明的新集合一致；
  - final 提交后有效配置切换为 new。
- 逐事件快照展示：各副本日志末尾、本地/全局已提交索引、当时有效配置、构成多数的节点；
  首次失败即定位（缺失匹配副本 / 非法截断 / 错误配置阶段），并保留此前全部快照。

## 运行

```bash
# 本地（零依赖）
npm start                # 默认 0.0.0.0:8080
PORT=9090 npm start      # 可配置端口

# Compose
docker compose up web          # 静态站点，端口可用 PORT_APP 覆盖
PORT_APP=9090 docker compose up web

# 一次性验收（测试 + 页面构建检查 + 业务场景复核 + HTTP 冒烟，退出码报告结果）
docker compose build verify && docker compose run --rm verify
# 或本地：
npm run verify
```

健康检查：`GET /health` → `200 {"status":"ok",...}`。

## 目录

| 路径 | 说明 |
| --- | --- |
| `public/js/raft.js` | 复核引擎（浏览器与 Node 共用的纯逻辑模块） |
| `public/js/app.js` / `index.html` / `css/styles.css` | 录入与逐事件回放页面 |
| `server.js` | 零依赖静态服务（`PORT` 可配置，含 `/health`） |
| `verify.js` | 名为 verify 的一次性验收可执行，完成后退出并以退出码报告结果 |
| `test/raft.test.js` | `node:test` 单元测试 |
| `Dockerfile` / `docker-compose.yml` | 静态站点 `web` 与一次性验收服务 `verify` |

预置场景内置在页面下拉框中：正常联合变更、联合阶段新集合多数不足、未经 joint 提交 final、非法覆盖已提交项。
