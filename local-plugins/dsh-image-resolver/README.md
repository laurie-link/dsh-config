# @local/dsh-image-resolver

在 DSH 里复刻 ChatGPT Intelligent UI 的 `AsyncImage`：**模型只写一句画面描述，图由宿主补**。

模型侧写法（无需知道任何 URL）：

```
{"type":"image","src":"/img-resolve?q=slow roasted rosemary garlic lamb shoulder","alt":"lamb shoulder"}
```

浏览器请求 `/img-resolve?q=…` → 插件在宿主侧搜图 → `302` 到真实图片地址 → `<img>` 正常显示。

## 为什么不用改 genui

`dsh-genui` 的 `safeMediaSrc`（`src/client/genui-runtime/value-utils.ts`）本来就放行**同源相对地址**，
而宿主 `webServer` 注册的前缀路由（genui 自己的 `/plugins/@changfenhuang/dsh-genui/assets` 同款机制）
在桌面端会经 `dsh-app://app/` 协议处理器带鉴权转发（`app.asar/lib/main.js` 的 `forwardWebRequest`）。
所以「模型写描述 → 宿主补图」这条链路只要新增一个路由，组件层零改动。

## 接口

| 参数 | 说明 |
| --- | --- |
| `q` | 必填，画面描述 |
| `w` | 可选，目标宽度，默认 900，范围 120–1600 |
| `engine` / `src` | 可选，交给 dsh-image-hunt 的图源别名：`auto` / `intl` / `cc` / `anime` / `icons` / `baidu` / `bing` / `duitang` / `pixiv` … |
| `sources` | 可选，逗号分隔的图源 id 列表，优先于 `engine` |
| `debug=1` | 返回 JSON（`{query,width,engine,url}`），排查用，不跳转 |

- 上游：优先借用同 profile 里 `dsh-image-hunt` 的 14 个图源（百度 / Bing / 360 / 堆糖 / 花瓣 / DuckDuckGo / Yandex / Openverse / Wikimedia / Pixiv / Wallhaven / Konachan / Safebooru / Iconify）；6 秒内没结果就退回内置的 Wikimedia 检索（4 秒预算）。全程失败才 404。
- `dsh-image-hunt` 是**可选依赖**：没装、加载失败、代理不通都不影响路由启动，只是少了 13 个源。
- 缓存：进程内 30 分钟 / 500 条。
- 只注册 `GET|HEAD`，不接受任何用户可控 URL（无 SSRF 面），`q` 截断到 200 字符。

## 安装（本机 profile）

```bash
# 1) 放进 profile 的 node_modules（不想动 pnpm 就直接拷目录）
mkdir -p ~/.dsh/profiles/desktop/node_modules/@local
cp -R "<本目录>" ~/.dsh/profiles/desktop/node_modules/@local/dsh-image-resolver
```

```yaml
# 2) ~/.dsh/profiles/desktop/cordis.patch.yml —— 放到顶层已有的 - insert: 列表里
    - id: image-resolver
      name: "@local/dsh-image-resolver"
```

```bash
# 3) 重启 DeepSeek Harness（profile patch 在启动时生效）
```

验证：让模型写一个 `src` 为 `/img-resolve?q=roasted lamb shoulder` 的 image 节点，应显示烤羊肩；
或在已登录的浏览器标签里打开 `http://127.0.0.1:63424/img-resolve?q=lamb&debug=1` 看 JSON。

回滚：删掉 `- insert:` 里的 `image-resolver` 两行，再删 `node_modules/@local/dsh-image-resolver`，重启。

## 离线自检

```bash
node -e '
import("./lib/index.js").then(async (m) => {
  console.log(await m.resolveImageUrl("roasted lamb shoulder", 900))
})'
```

## 候选列表与身份核验（2026-11-17）

`@local/dsh-async-ui` 现在调用 `resolveImageCandidates(query, width, { subject, sources })`，拿到**按分排序的候选列表**（最多 8 个），逐个下载直到成功；`resolveImageCandidate` 保留为「取第一个」的兼容封装。

- 每个图片候选带 `url`（原图）、`thumb`（搜索引擎 CDN 上的同一张图，基本不防盗链）、`referer`、`title/page/engine/score/tier`。
- `kind: 'page'` 的候选（官方页、可信文章）只带页面地址，下载时再用导出的 `pageLeadImage(pageUrl)` 取 og:image，不拖慢搜索返回。
- 多引擎各自计时（`pooledSearch`）：先返回的引擎只给其他引擎 1.5 秒宽限，一个引擎卡在验证码上不会连累其他引擎的结果；每个引擎取前 16 条。
- 两级核验：`trusted`（白名单来源，标题/URL/文件名命中主体）和 `title`（任意来源，但标题必须含全部主体词，且至少两个不同站点命中）。水印图库、AI 图、同人站、电商永远拒绝。
- 冲突否决：多出来的形态词、挂错对象的形态词、同系列不同代号、中文形态前缀，任一出现即拒绝（对页面绑定同样生效）。
- 排序：官方页 > 可信来源正文图 > 可信文章 og:image（常是带字的分享卡片）> 普通来源强标题匹配图。

### 画面类查询（2026-11-18）

按要点配图后，同一个 `s` 会配多张不同画面（`q=GTA 6 police chase` / `GTA 6 basketball` …）。

- `q` 里有主体之外的画面词时（`subjectProfile().context` 非空），排序改为：标题命中画面词的优先 →
  真实页面优先于 YouTube/Pinterest 等转载 → 可信来源优先 → 分数；官方页和文章主图放最后。
- 引擎 `bing-cn` 是本插件自己的 cn.bing.com 单页搜索（`searchBingCn`），不经过 image-hunt：
  热门话题期间 www.bing.com 会对所有相关查询返回同一组新闻图，cn.bing.com 仍按画面返回。
- 多引擎并行时，先返回的引擎给其他引擎 3 s 宽限（DuckDuckGo 走代理要两次往返）。

## 已知限制

- Wikimedia 是关键词 AND 检索，纯抽象的意象（"赛博朋克城市夜景中的一只猫"）命中率差；接真图搜（Brave Images / Google CSE）只需换掉 `searchOnce` 里的上游请求。
- 结果不保证语义正确，只保证「有一张相关图」。要序列敏感就加 `i=0..n` 之类的 picking 参数。
- 302 跳转到 `thumb.wikimedia.org`，需要宿主机能出网；离线环境请改成返回本地占位图。
