# dsh-personalization

ChatGPT 风格「个性化」设置的本地 DSH 插件：六个下拉写进系统提示词。

| 下拉 | 值 |
| --- | --- |
| 基础风格和语气 | 默认 / 专业严谨 / 轻松自然 / 直接简洁 / 温暖耐心 |
| 亲切程度 | 默认 / 更克制 / 更亲切 / 很亲切 |
| 热情程度 | 默认 / 更冷静 / 更热情 / 非常热情 |
| 表情符号 | 默认 / 少用 / 不用 / 多用 |
| 可视化回答 | 默认 / 更少 / 更多 |
| 标题和列表 | 默认 / 减弱 / 增强 |

- 界面：设置（Settings）→ 个性化。
- 存放：`~/.dsh/personalization.json`，改完下一轮回复立即生效，不需要重启。
- 生效方式：Host 在系统提示词里注册 `local:personalization` 段落（order 4000），
  只把非「默认」的维度渲染成规则行；全默认时不产生任何段落。
- 路由：`GET /dsh-personalization/config`、`POST /dsh-personalization/set`。

Host half 是普通 Cordis 插件（`index.js`），Client half 是 loader 直接吃下的
plain-JS 模块（`client.js`，`window.__ModuleLoader__.load`），没有构建步骤。
