# dsh-debug-mode

DSH 的 **Cursor 式 Debug 模式**：`/debug` 开启一次「运行时证据驱动」的调试会话，agent 先列根因假设、给代码插桩（埋点），由你手动复现 bug，agent 读真实运行时日志定位根因，再做最小修复，最后清理所有埋点并做残留检查。

## 用法

```
/debug <bug 描述 + 复现步骤>    开启调试会话（agent 会开始列假设并插桩）
/debug status                   查看会话、端点、已收集事件数
/debug logs [条数] [--grep 词]  查看最近收集到的事件（默认 100）
/debug stop                     结束会话并扫描工作区里的残留埋点
/debug cleanup                  只扫描残留埋点
/debug help                     帮助
```

模型侧也有同名能力：工具 `debug_mode`（`action: start|status|logs|stop|cleanup|help`）。`start` 返回完整的 mission 与端点，适合子代理/无 UI 场景。

## 工作流（和 Cursor Debug Mode 对齐）

1. **探索建假设**：agent 读相关代码，列出 3–5 个具体根因假设。
2. **插桩**：在能区分这些假设的代码路径上加「fire-and-forget」日志，POST 到本机端点。
3. **你复现**：agent 给出精确复现步骤后停下等你；你按步骤复现 bug。
4. **读日志**：agent 用 `debug_mode action=logs` 读取变量、分支、时序等真实数据，指出根因。
5. **最小修复**：只改与根因相关的几行。
6. **验证 + 清理**：你确认修复后，agent 删除全部插桩，`debug_mode action=stop` 扫描残留标记，确认 0 残留后收尾。

## 实现要点

- 收集端点：宿主插件在 `127.0.0.1` 上随机端口起一个 HTTP server（懒启动、进程内复用），每个调试会话一个随机 token 路径：`http://127.0.0.1:<port>/ingest/<token>`。
  - 接受 `application/json` / `text/plain` 的单个 JSON 对象、JSON 数组或 NDJSON；带 CORS，浏览器前端代码也能直接 POST。
  - `GET /health`、`GET /status/<token>`、`GET /_state?sessionId=`（本机诊断，返回将注入的上下文文本）不参与模型链路。
- 产物：会话工作区 `.dsh-debug/<id>/`
  - `events.ndjson`：原始事件（含 `receivedAt`）
  - `meta.json`：会话元数据
  - `README.md`：端点、事件格式、JS/Python/shell 埋点片段、硬规则
  - `.dsh-debug/.gitignore` 内容为 `*`，整个目录不进 git。
- 每步上下文：通过 agent 作用域的 `systemPrompt.context` 注入（未激活时文本为空，不影响 prompt）；上下文包含 bug 摘要、端点、标记、事件数与工作流提醒。
- 清理检查：每个插桩行必须带注释标记 `dsh-debug:<id>`；`stop/cleanup` 在确认当前会话的 cwd 内扫描（跳过 node_modules/.git/dist 等，20k 文件 / 5s 预算）。
- 事件上限：每会话 10000 条，单 body 512 KiB，单事件 data 序列化上限 4 KiB。

## 约束与已知限制

- 模式状态存在宿主进程内存里：**DSH 重启后调试会话不保留**（`.dsh-debug/<id>/` 产物仍在磁盘上，可手动查）。
- 日志默认走 HTTP；如果运行环境无法访问 `127.0.0.1`（容器/远程/严格 CSP），README 里给了「直接 append NDJSON 到 events.ndjson」的兜底方案。
- 依赖 `commands` / `tools` / `systemPrompt` 三个服务；缺任一服务的精简 profile 里插件不会激活。
- 不做自动改代码：清理埋点由模型按标记删行，插件只负责扫描与报告。

## 安装 / 卸载

- 安装：`plugin_manager` 的 `install_bundle` 指向本目录（或手动 link 进 profile 的 `dependencies` + `dsh.profile.bundles`）。
- 卸载：从 profile 移除 bundle；插件卸载时会关闭 HTTP 端点并清掉上下文注册。
- 改宿主代码（`index.js` / `lib/`）后需重启 DSH；纯 `locale`/`icon` 改动刷新页面即可。

## 测试

```bash
cd ~/dsh-plugins/dsh-debug-mode
node --test tests/*.test.mjs
```
