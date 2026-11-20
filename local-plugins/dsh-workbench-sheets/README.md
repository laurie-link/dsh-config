# dsh-workbench-sheets

DSH 官方右侧 Sidebar（Cursor 视图的中间工作台）里的可编辑 CSV / TSV / XLSX 页签，
保存时写回原文件。纯 JS 双半插件，无构建；XLSX 读写用本地 `exceljs@4.4.0`。

## 行为

- 打开 `dsh-resource://file/**` 且后缀为 `.csv` / `.tsv` / `.xlsx` 的文件时接管正文。
- CSV/TSV：表格编辑（行号 + A/B/C 列头），可加行/加列；保存保留原 BOM、编码、
  分隔符、行结束符风格与结尾换行。
- XLSX：多工作表页签；只渲染值、编辑公式时显示 `=...`；保存只提交改动过的 cell
  （`edits`），Host 用 ExcelJS 加载原文件后最小改动写回。检测到图表/图片/透视表/
  条件格式时，保存前会 `confirm` 提示可能丢失。
- 保存：工具条「保存」按钮或 `Ctrl/Cmd+S`；`Enter` 提交并下移、`Tab` 右移、
  `Esc` 取消、失焦提交。
- 版本守卫：保存前比对读文件时的 `mtimeMs`/`size`，外部改动过则 409 拒绝并提示
  重新加载；写盘走「同目录临时文件 + rename」避免写坏原文件。
- 尺寸上限：单文件 32 MiB、单元格总数 30 万；超限返回可读中文错误，不白屏。

## Host 路由（loopback 同源）

- `GET /workbench-sheets/file?sessionId=<sid>&path=<relpath|abs>`
- `POST /workbench-sheets/save`（CSV 传 `rows`，XLSX 传 `edits`）
- `GET /workbench-sheets/ping`

相对路径按会话 cwd 解析（agents/sessions 服务 → workingDirectory；取不到返回可读错误），
绝对路径直接使用。

## 自测

```bash
cd ~/dsh-plugins/dsh-workbench-sheets
npm test          # node --test tests/*.test.mjs
npm run check     # node --check 全部 JS
```

测试使用 `~/Documents/视频/_dsh-preview-test/` 样例文件的 /tmp 副本，不会改原件。
