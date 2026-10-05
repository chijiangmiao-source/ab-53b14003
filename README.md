# 飞控冗余集群 · 成员变更复制/提交轨迹复核器

审查员复核失效计算节点替换期间捕获的复制与提交轨迹，在浏览器内按序回放，
确认成员变更期间没有以错误多数提交指令。

## 复核规则

- 初始节点 **3~5 个**，成员变更至多 **2 次**，事件至多 **48 项**，事件按序回放。
- 复制事件含：目标节点、前驱索引 `prevLogIndex`、前驱任期 `prevLogTerm`、连续日志项。
  - 仅当目标副本在 `prevLogIndex` 处的任期等于 `prevLogTerm`（`prevLogIndex=0` 视为从头）时才追加；
    否则拒绝追加（定位为「前驱不匹配 / 缺失匹配副本」）。
  - 连续区间与本地同任期条目幂等；任期冲突时截断**未提交**尾部再追加；
    **已提交项不得覆盖**，冲突判为「非法截断」，失败事件不落盘任何修改。
- 成员变更采用联合共识两阶段：
  1. 先复制并提交 `joint(old,new)` —— 提交时须**同时**取得旧集合多数与新集合多数；
  2. 仅在 joint 生效期间才可复制并提交 `final(new)`，且 final 集合必须等于 joint 的 new；
     提交计票仍按联合双侧多数，完成后配置回到 stable；
  3. 非 joint 生效期间提交 final、嵌套开启 joint、final 集合偏离均判为「错误配置阶段」。
- 每次提交须由该索引（条目任期）匹配的副本凑齐当时有效配置所需多数。
- 逐事件展示：每个副本日志末尾、全局已提交索引、当时有效配置（stable / joint 双侧集合）、
  构成多数的节点；首次失败即停止，给出失败分类与定位（缺失的匹配副本 / 非法截断下标 / 配置阶段），
  并完整保留此前全部快照。

## 本地运行（无需 Docker，Node >= 18）

```bash
npm run build     # 页面构建检查：web/ + src/engine.js -> dist/
PORT=8080 npm start
# 浏览器打开 http://localhost:8080 ，健康检查 http://localhost:8080/health
```

仅运行引擎测试：`npm test`

## Compose 启动（静态站点）

```bash
docker compose up --build                 # 默认宿主端口 8080
WEB_PORT=9090 docker compose up --build   # 可配置端口
curl http://localhost:8080/health
```

## 一次性验收服务 verify

`verify/verify` 是**名为 verify 的可执行**一次性验收服务，依次执行：

1. 引擎代码测试（52 项断言）；
2. 业务场景复核：联合双侧多数（缺旧/缺新）、final 先于 joint、joint 嵌套、
   final 集合偏离、非法截断已提交项、前驱缺失匹配副本；
3. 页面构建检查（产物齐全且入口正确）；
4. HTTP 冒烟（`/health` 200 与健康体、首页及静态资源 200、越权路径拒绝）。

全部通过退出码 `0`，任一失败退出码 `1`。

```bash
# 方式一：直接在本机执行（未提供 BASE_URL 时自行拉起 server.js，冒烟后关闭）
./verify/verify
# 或指定端口 / 对已有站点冒烟
SMOKE_PORT=19000 ./verify/verify
BASE_URL=http://localhost:8080 ./verify/verify

# 方式二：Compose（先起 web，健康后在容器内对 http://web:8080 冒烟）
docker compose --profile verify run --rm verify
```

## 目录

| 路径 | 说明 |
| --- | --- |
| `src/engine.js` | 无依赖回放复核引擎，浏览器与 Node 共用（ESM） |
| `web/` | 静态页面（录入表单、示例场景、JSON 互导、逐事件快照渲染） |
| `server.js` | 零依赖静态服务器，端口 `PORT` 可配，提供 `/health` |
| `scripts/build.mjs` | 页面构建（拷贝并校验产物） |
| `test/engine.test.mjs` | 引擎单元测试 |
| `verify/verify` | 一次性可执行验收服务 |
| `Dockerfile` / `docker-compose.yml` | 镜像与编排（web + verify profile） |

## 轨迹 JSON 格式

```json
{
  "nodes": ["n1", "n2", "n3"],
  "events": [
    { "type": "replicate", "target": "n1", "prevLogIndex": 0, "prevLogTerm": 0,
      "entries": [{ "term": 1, "config": { "kind": "joint", "new": ["n1","n2","n3","d"] } }] },
    { "type": "commit", "index": 1 }
  ]
}
```

- `entries[].config.kind` 为 `"joint"` 时 `new` 为新集合，`old` 可省略（自动取当前生效配置）；
  `"final"` 时 `nodes` 必须等于当前 joint 的新集合。
