# @local/dsh-async-ui

给 DSH GenUI 补上 ChatGPT Intelligent UI 的 **AsyncImage** 语义：模型只写一句图片描述（`query`），宿主把它换成真正能加载的图片，再交给 GenUI 自己的卡片渲染器画出来。

它不是又一个 UI 框架，而是**接管 `render_ui` 这个工具名**：GenUI 照常渲染，26+ 组件照常复用，只在 spec 进渲染器之前插一层"描述 → URL"的解析。

## 怎么工作

```
模型 → render_ui({ items: [{ type: 'image', query: '赛博朋克夜景 城市 霓虹' }] })
      ↓ execute()        预解析：把每句描述交给 @local/dsh-image-resolver 搜图（~1 s 冷启动）
      ↓ presentationMeta() 改写：{ query } → { src: '/async-ui-img?q=…&w=900' }
      ↓ 工具结果的 meta
      ↓ GenUI 的 toolview（key: render_ui）画卡片
浏览器 → GET /async-ui-img?q=…   ← 同一个进程、同一张缓存表，命中时 302 只要 ~1 ms
      ↓
客户端 client.js：图片未落地前给一个微光占位框，load 后摘掉
```

`src`、`image`、`poster` 已经存在的节点一律不碰——本机截图（`/api/file?path=…`）和写死的 https 链接原样通过。

## 前置条件

1. 安装 `@local/dsh-image-resolver`（负责真正搜图，14 个图源 + Wikimedia 兜底）。
2. GenUI 让出工具名：`cordis.patch.yml` 里 genui 条目加

   ```yaml
   - id: genui
     name: "@changfenhuang/dsh-genui"
     disabled: false
     config:
       renderUiTool: false
   ```

   否则两个 `render_ui` 重名，先注册的赢。

3. 新增客户端半需要**重启 app** 才会被枚举（改已有客户端文件只需 Ctrl+R）。

## 安装

```bash
dsh plugin --profile desktop add link:/绝对路径/dsh-async-ui
```

## 配图策略：按要点配图（2026-11-18）

同一个 GTA 问题，ChatGPT 配了 14 张（8 处，每个讲画面的要点下面一张），DSH 里的
DeepSeek 只配了 1 组 4 张。它的思考里写着 "Careful not to over-component… minimal-yet-rich"，
按"核心实体"数到 4 张就停，并把这组图当成整条回答的"视觉焦点"。压低图量的有四处：

| 来源 | 原话 | 处理 |
| --- | --- | --- |
| GenUI 技能（回答前最后加载） | 删掉这个组件读者会不会更费劲 / 焦点唯一（最大那张图）/ 一个主题一个主组件、宁缺毋滥 | `SKILL.md` 加「图片例外」本地补丁（存档在 `~/dsh-profile-sync/patches/dsh-genui`） |
| `~/.dsh/instructions/TOOLS.md` | 铁律：不复述正文；删掉测试 | 注明只管文字/数据组件，不管配图；配图规则改成按要点 |
| 个性化设置（`personality.md` + 插件 `RULES.media.rich`） | 常规回答 3–6 张、按实体计数 | 改成按要点配图，与本插件一致 |
| 本插件旧规则 | 按核心实体计数；同一实体重复出现不重复配图 | 整段重写（见下） |

现在注入的规则（`SECTION_TEXT`，`async-ui:images` 段）要点：

- **按要点配图**：开头一张代表图；每个章节第一段后至少一处；每个讲到能看见的东西（外观、
  地点、角色、玩法画面、战斗、载具、形态、场景）的要点后面紧跟一张图，`q` 写这个画面；
  并列 3 样以上用一组 `image-group`；对比的两边都要有图。
- **数量是下限**：图片数 ≥ 章节数 + 讲可见事物的要点数；常规回答 6–10 张、长回答 10–16 张。
- **同一对象可以多张**，只要画面不同；`s` 写对象本身，画面差别写进 `q`
  （`s=Grand Theft Auto VI`，`q=GTA 6 police wanted level chase screenshot`）。
- 明确声明「删掉组件 / 焦点唯一 / 不复述正文 / 一个主题一个主组件 / 宁缺毋滥」不约束配图。
- 正文里一串可见事物（"篮球、潜水、划艇都能玩"）和表格里的可见变化也要配一组图；附一条回答骨架示例。
- **图组放足**（2026-11-18 晚）：image-group 只露 3 张、其余叠层，所以同一主题的组图常见 6–10 张、
  最多 24 张，图片总数不设上限；第 4 张以后在用户翻到之前不会请求，不增加取图负担。
- 附两段 `dsh-ui` 写法示例和发出前的逐条自检。

实测（重放那条 GTA 会话：同样的上下文和搜索结果，只换提示词，deepseek-v4.1-flash、思考强度 max）：

| | 图片数 | 放置处数 |
| --- | --- | --- |
| 改前 ×2 | 4、5 | 1、1 |
| 改后 ×3（三处提醒 + 新规则） | 10、8、9 | 5、4、5 |
| ChatGPT 同一问题 | 14 | 8 |

改后的回答按"封面 → 地图组图 → 双主角 → 日常活动组图（篮球 / 潜水 / 划艇）→ 上一代对比"展开，
结构与 ChatGPT 那条一致。重放脚本思路：从会话日志还原到第 8 步（genui 技能已加载），之后让模型
自行继续，联网工具按原调用返回原结果，`validate_dsh_ui` 返回通过；opencode-go 需要 `x-opencode-session` 头。

### 配图提醒（放在模型动笔前读到的位置）

完整规则在系统提示里，离模型动笔的位置隔着几万字，而 GenUI 技能是回答前最后读到的。
插件把一条简短提醒（`<system-reminder>`，`source = {kind: 'async-ui-image-reminder', form: 'notice'}`）
放在三个地方：

1. `agent/pre-step`：这一步带着**用户的新消息**时，跟在它后面（每轮用户消息一次）；
2. `tools/post-execute`：`skill(genui)` 的结果后面——紧挨着那几条极简原则；
3. `tools/post-execute`：`validate_dsh_ui` 的结果后面（模型发围栏前会先校验；同一 agent 5 分钟内只附一次）。

提醒会和这些消息一起写进会话记录。插件配置 `imageReminder: false` 可以全部关掉。

**不要在每一步都追加**：`agent/pre-step` 的 `messages` 是这一步要**写进会话的新消息**，agent 靠
"这一步还有没有新消息"判断一轮是否结束（`if (turnEnds && decision.messages.length === 0) break`）。
2026-11-18 第一版每步都追加，上线后十几分钟内就发现一个会话每步都多出一条提醒，随即改成上面的
写法并重载；如果这样放着，模型答完后会因为又有了"新消息"继续下一步、停不下来。工具结果上附带
的内容进的是下一步队列，而调用过工具本来就会有下一步，所以 2、3 两处不影响收尾。

### 后端配合：同一对象的多张画面图

按要点配图后，一条回答会对同一个 `s` 发出多个不同 `q`。为此：

- **按画面排序**：`q` 里有主体之外的画面词（police、chase、basketball…）时，标题命中画面词的
  候选优先；其中真实页面优先于 YouTube/Pinterest 等转载；官方页封面和文章主图放到最后，
  否则每个 GTA VI 画面都会拿到封面。
- **去重按 `s + q`**：10 分钟内已经发给别的请求的同一张图（内容哈希相同）会被跳过。
- **cn.bing.com 作为独立引擎**：GTA VI 发售前一天，www.bing.com 对所有 "GTA 6 …" 查询都只返回
  同一组发售新闻图、DuckDuckGo 对突发请求返回 403，而 cn.bing.com 对每个画面都给出对题结果
  （约 0.4 s）。第一阶段现在是英文 `bing + bing-cn + duckduckgo`、中文 `baidu + so360 + bing-cn`。
- 先返回的引擎给其他引擎的宽限从 1.5 s 放宽到 3 s（DuckDuckGo 走代理要两次往返）。

## 配置

插件条目可带 `config:`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `maxImages` | `12` | 仅保留给旧 render_ui tool 路径；当前 profile 使用 dsh-ui 围栏 + `/async-img`，不受这个 12 张上限限制，图片数量由模型输出的 image/image-group 节点决定 |
| `width` | `900` | 向图源请求的宽度；会显式写进 URL 的 `w=`，保证路由与预取命中同一缓存键 |
| `engine` | 无 | 指定图源（`baidu` / `bing` / `duitang` / `cc` …） |

## 自检

```bash
# 卡片里图片的 src 应形如 /async-ui-img?q=…&w=900
curl -s -o /dev/null -D - "http://127.0.0.1:<port>/async-ui-img?q=<描述>&w=900"
#   x-async-ui: warm → 工具调用时已预热（~1 ms）
#   x-async-ui: resolved → 这里才去搜（~1 s）
```

工具结果里的 `prefetch=K/N` 是预热命中率，`resolve_route=` 说明当前用的是本插件路由还是兜底的 `/img-resolve`。

## 占位块怎么自测

`test/placeholder.html` 是一个脱离 DSH 的夹具页：它用同样的 DOM 形状加载 `client.js`（自带极简 `__ModuleLoader__` 垫片），左图的地址指向一个故意慢 3 秒的本地代理，右图指向真实解析路由。用浏览器打开它，就能看到「灰色骨架块 → 图片淡入」的完整过程，不需要动真实会话。

验证要点：慢图的 `data-async-pending` 存在约 3 秒（`getAttribute` 可查），期间高度为预留的 16:9 框，`load` 之后属性消失、高度收敛到图片真实比例。

## 边界

- 预算是硬的：`execute()` 最多等 4 秒，没解析完的会在路由请求时继续解析，不会卡住对话。
- 搜不到就是 404（`x-async-ui: unverified`），GenUI 会把这一格直接丢掉，不显示任何占位/错误卡片。
- 单张图最多花 30 秒搜索 + 下载，之后再给页面绑定兜底 12 秒；超了就 404。
- 原图有防盗链/超时/挂了，会自动换成搜索引擎自己 CDN 上的缩略图（见下节），不再直接裂图。

## 取图稳定性（2026-11-17）

那次「放了 4 张、裂了 2 张」逐个复现后，原因都不在网络，而在链路本身：

| 现象 | 根因 |
| --- | --- |
| Lucia Caminos 404 | 24 个搜索结果里一半标题直接写着她的名字，但来源站不在 ~30 个域名的白名单里，全部被拒 |
| GTA V 洛圣都只有 136×77 | jimp 解不了 WebP，尺寸检查被 `catch` 静默跳过，缩略图被当成正图 |
| 一个候选 403 就换整套搜索 | 每个搜索计划只返回 1 个 URL，失败后从头搜下一个引擎 |
| 一个引擎卡住整阶段作废 | `searchAll` 要等最慢的引擎，DuckDuckGo 碰到验证码时连 Bing 的好结果一起丢 |

现在 `/async-img` 的链路：

```
内存缓存(10 分钟) → 磁盘缓存(30 天) → 同键请求合并 → 3 分钟失败缓存
  → 第 1 阶段：英文 bing+duckduckgo / 中文 baidu+so360，各引擎独立计时，先到的只等 1.5 s
  → 身份核验（dsh-image-resolver），得到按分排序的候选列表（最多 8 个）
  → 依次下载：原图 → 引擎缩略图；2.5 s 没回来就并行起下一个，先成功的赢
  → 第 2 阶段：英文 yandex+wikimedia+openverse / 中文 bing+wikimedia，同时起页面绑定
  → 最后：官方页 / 维基主图 / 可信文章 og:image
```

- **身份核验分两级**：可信来源（原白名单）照旧；其他站点则要求**标题本身**含全部主体词，并且至少两个不同站点同时命中才采信。水印图库、AI 图、同人站、电商一律拒绝；Pinterest/YouTube 等降权。
- **冲突一票否决**（两级都适用）：标题或文件名里出现主体没有的形态词（`Mega Houndoom` 配给 `Houndoom`）、主体的形态词挂在别的名字上（`Houndoom vs Mega Gengar`）、同系列不同代（`GTA 5 vs GTA 6` 配给 GTA 6）、中文形态前缀（`超级黑鲁加` 配给 `黑鲁加`）。
- **字节校验**：按文件头读出 JPEG/PNG/GIF/WebP/AVIF/BMP 的真实尺寸，短边 < 200 或长宽比 > 3.6 都不要；SVG/HEIC/HTML 冒充图片直接拒。
- **同图去重**：10 分钟内已经发给别的主体的同一张图（按内容哈希），会跳到下一个候选，避免一个回答里 Jason 和 Lucia 显示同一张主视觉。
- **大图压缩**：超过 1.5 MB 且长边 > 1600 的 JPEG/PNG 用 `sips` 缩到 1600（PNG 保留透明）。
- **磁盘缓存**：`~/.dsh/cache/async-img/`，上限 400 MB、30 天，按修改时间淘汰。旧对话重开、DSH 重启后同一张图 ~20 ms 原样返回。改了匹配规则要让缓存作废就把 `BYTE_CACHE_VERSION` 加一；想全清就删掉这个目录。

排查用的响应头：

| 头 | 含义 |
| --- | --- |
| `x-async-ui` | `warm` 内存 / `disk` 磁盘 / `resolved` 第 1 阶段 / `source-fallback` 第 2 阶段或页面绑定 / `unverified` 404 |
| `x-async-ui-via` | `full` 原图 / `thumb` 引擎缩略图 / `page` 页面主图 |
| `x-async-ui-build` | 匹配器版本（= `BYTE_CACHE_VERSION`），用来确认热重载后跑的是新代码 |
| `x-async-ui-match` / `x-async-ui-page` | 通过核验的标题与来源页 |

`ASYNC_UI_DEBUG=1` 时，404 会在宿主日志里打印每个候选失败的原因。

回归（20 个真实会话里的查询同时请求，含 GTA、宝可梦形态、深圳地标、一个故意的乱码查询）：19/19 出图且主体正确，乱码查询 404；单张 3–8 秒，磁盘命中约 20 ms。

回滚：把 `lib/index.js.before-reliable-fetch-20261117.bak` 和
`../dsh-image-resolver/lib/index.js.before-reliable-fetch-20261117.bak` 拷回原位，再在 profile 的 `cordis.patch.yml` 末尾加一行 `#` 注释触发重载。

## 回滚

删掉 genui 的 `config.renderUiTool: false`（把 `render_ui` 还给 GenUI），再

```bash
dsh plugin --profile desktop remove @local/dsh-async-ui
```

## 灯箱：点空白关闭

GenUI 的 `image-group` 灯箱是原生 `<dialog>`：`showModal()` 打开后，点背景板什么都不会发生，只有 `×` 和 `Esc` 能关。原生行为里点击背景板的 `event.target` 就是 `<dialog>` 元素本身，所以 `client.js` 在 document 上捕获这种点击，向该 dialog 派发一个冒泡的 `keydown`（`key: "Escape"`），触发 GenUI 已有的关闭逻辑；万一上游没有 Esc 处理器，再退一步点 `×` 按钮。

识别用 `dialog[open][aria-labelledby$="-dialog-title"]`（GenUI 给这个灯箱固定加的 `aria-labelledby`），改名时只会退化成"什么都不发生"，不会误关别的对话框。

自测：`test/lightbox.html` 用原生 `<dialog>` 复刻该结构，`python3 -m http.server 8899` 后打开 `http://127.0.0.1:8899/test/lightbox.html`，点图不关、点背景关，日志显示 `closed-by-escape` 即为主路径生效。

## 图片组标题：默认的那个不显示

GenUI 给每个 `image-group` 都画一行标题：`<h3>{node.title ?? t('block.imageGroup')}</h3>`（`src/client/blocks/image-group.tsx:149`），默认文案是「图片组」/「Image gallery」。规格里没有"不要标题"的开关，所以 `client.js` 在扫描 DOM 时，只对**仍是默认文案**的标题打 `data-async-ui-hide`（`display: none`）；显式写了 `title` 的一律保留。

- 想显示标题：在 `image-group` 里写 `"title": "……"`。
- 语言切换/流式补字也能命中：observer 同时监听 `childList` 与 `characterData`，并回查 `record.target`，标题后填也会被处理。
- 自测：`test/title.html`（默认文案 / 显式标题 / 英文 locale 三个 case），打开后 `window.__result()` 应返回 `hidden: true, false, true`。


## 图组看图器：滑动翻页、点空白关闭（2026-11-18）

GenUI 的 `image-group` 现在是 ChatGPT 式便当布局（本地补丁，见
`~/dsh-profile-sync/patches/dsh-genui/changes/PATCH.md` 最后一节）：3 张起"左大右二"，
超过 3 张时第 3 格叠层显示总数，点开是全屏看图器。看图器本身只认 ←/→ 和两侧按钮，
`client.js` 在 document 上补了三种操作，都不碰 GenUI 内部：

- **滑动**：在看图器里横向拖动 ≥ 48px（且横向位移大于纵向的 1.2 倍）就给 dialog 派发
  `ArrowLeft` / `ArrowRight` keydown，走 GenUI 自己的翻页；拖动结束时那次 `click` 会被吞掉，
  免得被当成"点空白关闭"。
- **触控板横扫**：横向 `wheel` 累计 ≥ 60px 翻一页，之后在滚轮事件停 220ms 之前都锁住——
  macOS 抬手后还会持续发一秒衰减的滚轮事件，不锁的话一次手势会连翻好几页。
- **点空白关闭**：点 dialog 本身、画框空白，或者 `object-fit: contain` 留出的黑边（`<img>`
  元素铺满画框，所以按图片实际绘制的区域判断）都会关闭；点图片本身不关。

**叠层里的图会在后台预热**：GenUI 图组进入视口附近 1.2 秒后，把第 4 张起的图排进全页面队列、同时 2 张在后台请求；`/async-img` 的成功响应改为 `cache-control: private, max-age=600`，预热下来的图点开时直接读浏览器缓存（模拟 3 秒取图时，第 4 张从 3067ms 变成 2ms）。404 仍是 no-store。

自测：独立运行时 + `client.js` 的测试页（4 组图：8 / 3 / 2 / 1 张），ego-browser 实测
叠层显示 8、从第 3 张打开、左拖到第 4 张、右拖回第 3 张、一次触控板手势只翻一页、点黑边和
外圈都关闭；打开前只请求可见的 3 张，打开后预取第 4、5 张。

## 图片放大：普通 image 也能点开

GenUI 只给 `image-group` 的缩略图装了灯箱（缩略图外面是 `<button aria-haspopup="dialog">`）。
卡片、条目里用的普通 `image` 节点渲染出来是裸 `<img>`，点了没有任何反应——九宫格那种
`grid` + `card` + `image` 的结构就全是死的。

`client.js` 补了一层通用放大，不改 GenUI：

- 捕获阶段接管 `[data-genui]` 内 `<img>` 的点击；`closest('button, a')` 命中的（图库缩略图）
  直接放行，交给 GenUI 自己的灯箱，避免叠两层
- 弹出 `[data-async-ui-zoom]`：`position: fixed; inset: 0` 的遮罩 + `max-width: 92vw;
  max-height: 92vh` 的 `<img>`，`role="dialog"` / `aria-modal="true"`
- 点遮罩或按 `Esc` 关闭；`ctx.effect` 卸载时移除监听并清掉遮罩
- 走 document 级委托，所以历史消息里已经渲染出来的旧卡片同样生效

**自测**：`test/zoom.html`（三个 case：普通 image / 按钮里的缩略图 / GenUI 区域外的图），
`python3 -m http.server 8899` 从包根起服务后，用 ego-browser 打开。实测结果：

| 检查 | 结果 |
| --- | --- |
| 遮罩铺满视口 | `position: fixed`，`1908×823` = 视口 |
| 放大图尺寸 | `1766×768`（受 92vw/92vh 约束） |
| 点遮罩关闭 | 遮罩数 `1 → 0` |
| Esc 关闭 | 遮罩数 `1 → 0` |
| 按钮里的缩略图 | 不弹自建遮罩（`0`） |
| GenUI 区域外的图 | 不接管（`0`） |

注：截图在 ego lite 里可能截到别的标签页（后台标签不出新帧），以 `page.evaluate` 的量测为准。

## 地图底图（`map` 节点）

GenUI 的 `map` 是**无底图的离线画布**：只画点位、连线、选中态。`setGenuiMapConfig` 是官方唯一的注入点，且只接受 **style 对象**，不接受 URL。

- 宿主半：`GET /async-img-style` 返回 `assets/liberty-style.json`（OpenFreeMap Liberty，42 KB，sprite/glyphs/tiles 都是绝对地址，可直接用）。
- 客户端半：`require.async('@changfenhuang/dsh-genui')`（先到达 graph row，避免加载顺序问题）→ `fetch('/async-img-style')` → `setGenuiMapConfig({ style })`。
- 失败可查：`<html data-async-ui-basemap="…">` = `ok` / `loading` / `fetch-…` / `no-module`。
- 自测：`python3 test/serve-map.py`（8901）→ 打开 `http://127.0.0.1:8901/test/map.html`，页面伪造模块表并延迟 1.2s 提供 genui，验证「等待 → 取样式 → 注入对象」。
- 换源：改 `assets/liberty-style.json` 即可（如 Carto Dark Matter 的 style.json），客户端不用动。

## 地图：紧凑排版、每行复制、全屏 + 滚轮缩放

genui 的 `map` 块本身是个表单：整宽的灰条「放大地图」、一行行大盒子、坐标只是一行灰字，而且 `scrollZoom: false`（聊天窗口要独占滚轮）。这里全部在 client 侧重排，不改 genui。

- **排版**：`section` 打 `data-async-map` → 列表行改成单行流式（名称加粗、说明与坐标弱化），控件收成小胶囊，地图右上角是浮动的「⤢ 放大」；地图挂载后（`data-async-map-ready`）隐藏「底图由宿主提供…」那行。

- **复制**：每个地点行是 `<button>`，里面不能套按钮，所以胶囊做成 `<li>` 里的**兄弟节点**，右对齐贴在行尾：图标 + 「复制坐标」，`5px 12px`、`border-radius: 999px`、约 `95×30`。点击后变绿「✓ 已复制」，1.6 秒复原；`stopPropagation` 免得顺带选中地点。坐标文字本身也保留 `cursor: copy`。

- **全屏**：点「⤢ 放大」把画布移进顶层 `<dialog>`（`showModal()`），关闭时插回原位。弹层是**满幅**的：画布 `position: absolute; inset: 0`，没有标题条和说明条；悬浮控件只有三样——左上「滚轮缩放 · 拖动平移」胶囊、右上圆形 `×`、右下 `+` / `−`。
  - 为什么不用 `position: fixed`：聊天容器里若有 `transform`，fixed 会以那个祖先为包含块，地图塌成一条窄带——第一版就是这么坏的。顶层 dialog 不受祖先影响。
  - MapLibre 把 `maplibregl-map` 加在**传入的那个容器**上，判定要同时看自身和子树。

- **滚轮缩放**：地图把 `scrollZoom` 关死了，而公开的只有「放大/缩小」按钮（`zoom(±1)` → `zoomTo(duration: 0)`）。全屏时在画布上接管 `wheel`（`preventDefault` + `passive: false`），每格点一次对应按钮；右下 `+` / `−` 走同一条路径。画布搬进 dialog 后 `parentElement` 不再是地图块，所以用 `WeakMap` 记住原 section 才能找到按钮。拖动平移是 MapLibre 默认能力，不用管。

- 夹具：`test/mapcopy.html`（按真实结构搭的 section：标题 / 画布 / status / 控件 / 地点列表，外层 `transform: translateZ(0)` 复现包含块问题），`python3 -m http.server 8902` 后打开。

实测（ego-browser + CDP）：

| 检查 | 结果 |
| --- | --- |
| 结构标记 | `data-async-map` / `data-async-map-controls` / 浮动按钮在画布内 `position: absolute` |
| 行排版 | `display: flex`，`padding: 6px 10px` |
| 复制胶囊 | `95×30`、`5px 12px`、`999px` 圆角、带图标，右对齐；点击后 `"✓ 已复制"`，1.6s 复原 |
| 滚轮 | 上滚 1 格 → `clicksIn=1`；下滚 → `clicksOut=1` |
| 全幅 | dialog `1832×806`，画布 `1832×806`，`inset: 0` 与弹层重合 |
| 悬浮控件 | `+`/`−` 在右下 `12px / 64px`，`×` 圆形，提示胶囊在左上 |
| 键盘/按钮 | `+ −` 触发 `2/1`；滚轮再触发一次 → `3/1`；关闭后 canvas 回卡片 |

## 图片来源标注（@async 更新）

- 宿主在解析成功时记住 `{title, page, engine}`（`sourceCache`，键 `width|query`），`serveAsyncImage` 成功分支写入。
- `GET /async-img-meta?q=<描述>&w=900` → `{query,title,page,engine}`；未校验过返回 `{}`；百度给的是混淆路径不是 URL → `page: null`（不给假链接）。
- 客户端对每个 `/async-img` 图在 `load` 后取一次 meta，在图片下方插一行 `来源：pokemon.fandom.com ↗`（`a[data-async-source-line]`，`stopPropagation` 避免触发灯箱）；`page` 为空则不插。
- 只有「标题命中主体词」的候选才会被记入，所以标注既是溯源也是自检：没有标注 = 这张图我没能验证。

## 页面绑定（resolveImageCandidate）

- 图像搜索同时给出候选图片所属 `page`；`bestPage()` 用同一套主体词规则选页面，再抓该页 `og:image`（`fetchPage` + `metaImage`，7s 超时、600KB 截断）。
- 命中就返回 `engine: 'page:og'`（图和来源是同一个对象）；拿不到 og:image 才退回原来的图片直链。
- `resolvePageImage()` 另外实现了「维基 pageimages → Bing SERP → og:image」，目前未接进主流程（Bing 会对本机返回空 200，不稳定）。
- `pageScore` 规则：最长主体词（`subject`）必须出现，否则丢弃——`Mega Houndoom pokemon` 曾落到 `mega.nz/login`。

## 全屏地图：地点跳转列表

- 进入全屏后左侧浮出 `[data-async-expand-list]`：标题「N 个地点」，每行一个地点按钮。
- 点击某行 = 按该地点在块内的原始 `<li><button>`，由 GenUI 自己完成「选中 + flyTo」，所以插件不需要拿到 MapLibre 实例。
- 末尾「回到全部」按块内的「重置视图」控件（`/重置/` 匹配）。
- 行标签取按钮 `innerText` 的第一行（genui 的 `locations` 是 `<ul><li><button>名字 + 坐标</button></li>`，见 `src/client/blocks/map.tsx:83-84`）。
- 夹具 `test/mapcopy.html` 实测：面板标题「3 个地点」、4 个条目、点第 2 项后原按钮 click 计数 1、点「回到全部」后重置计数 1、dialog 保持打开。

## 图集尺寸：交给 GenUI 的网格

2026-11-17 之后，GenUI 本地补丁把 `image-group` 改成了固定网格：按窗格宽度排
`floor((W+8)/148)` 列（1–5 列）、最多 2 行，每格统一 4:3、8px 间距，超出部分收进
最后一张「叠层卡」（右下角胶囊 = 叠层图标 + 图片总数）。所以图块尺寸已经不再跟着
图片自身的 `naturalWidth/naturalHeight` 走。

本插件因此**不再覆盖图块几何**。早期为了让参差的一排变整齐，`client.js` 给
`data-async-tile` 的 figure 强行加过 `flex: 1 1 150px`、`aspect-ratio: 1/1`、
`max-height: 200px`、`object-fit: cover`；这套规则现在会和新网格打架（把 4:3 撑成
1:1、把格子压到 200px），已整段删除，只保留：

- `img[data-async-pending] { min-height: 0; aspect-ratio: auto }` —— 骨架阶段不撑高

旧的 `test/tidy.html` 断言的是那套 181×181 的旧几何，已经不代表现状；想看现在的排版，
用 genui 仓库的 `verify/` 或 `~/.dsh-plugins` 外的 standalone 测试页。

## 未验证的图：404，不给占位图

`/async-img` 在没有任何候选通过校验时返回 **404**（`text/plain`，头
`x-async-ui: unverified`、`x-async-ui-placeholder: 1`），不再返回 900×900 的占位 SVG。
客户端把加载失败的格子交给 GenUI：GenUI 现在会把失败图直接摘出列表重排，全失败就整块
消失，不会留下「没有找到可核对的图」或「图片无法加载」的卡片。

宿主的 404 需要 DSH 重载插件才生效（改一行 `cordis.patch.yml` 即可触发，不用重启 App）。
在旧宿主上仍可能收到占位 SVG，所以 `client.js` 留了一个兜底：图片加载完成后，如果它是
900×900 且整张几乎都是 `#16181d` 底色（32×32 采样里 ≥80% 像素接近），就判为占位图，
把 `src` 换成 `/__async-ui__/unverified-image`（必然 404），由 GenUI 丢格子。

