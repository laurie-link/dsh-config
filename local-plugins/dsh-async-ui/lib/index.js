/**
 * `@local/dsh-async-ui` — AsyncImage semantics for DSH GenUI.
 *
 * The problem this solves: a GenUI `image` node needs a URL the browser can
 * load, but the model often only knows a *description* ("周报封面：赛博朋克夜景").
 * ChatGPT's Intelligent UI solves it by letting the model write
 * `<AsyncImage query="…"/>` and having the HOST resolve the tag into a real
 * `content_url` before the tree reaches the renderer.
 *
 * This plugin does the same one layer up and reuses GenUI's renderer:
 *
 *   model → render_ui({ spec with image nodes carrying "query" })
 *         → execute() resolves every description NOW (prefetch, ~1 s cold)
 *         → presentationMeta() rewrites each such node to
 *           { src: "/async-img?q=…&w=900" } — same process, warm cache
 *         → the spec lands in the tool result `meta`
 *         → GenUI's OWN keyed toolview (key "render_ui") draws the card
 *         → the browser hits /async-img; the host searches, verifies and
 *           downloads the picture itself and answers with the bytes (a
 *           memory or disk cache hit takes ~1–20 ms) while the Client half
 *           holds a shimmering slot open for it.
 *
 * Why own the route instead of reusing `/img-resolve`: that route lives in a
 * different plugin module instance, so its cache cannot be warmed from here —
 * every async image would pay the full search inside the browser's request.
 * Same process + same Map means the prefetch actually lands.
 *
 * Pairing requirement: GenUI must stop registering its own `render_ui` tool
 * (config `renderUiTool: false`) so this plugin can own the name and reuse
 * GenUI's toolview key. Nothing else about GenUI changes.
 *
 * @module @local/dsh-async-ui
 */

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

/** Our own late-resolving image route (warm cache lives behind it). */
const ROUTE = '/async-img'

/** The standalone resolver's route: fallback when our route cannot register. */
const FALLBACK_ROUTE = '/img-resolve'

/** Map basemap style served to the client half (GenUI's map node ships with no
 * tiles at all — `setGenuiMapConfig` wants an INLINE style, never a URL). */
const STYLE_ROUTE = '/async-img-style'
const META_ROUTE = '/async-img-meta'
const STYLE_FILE = new URL('../assets/liberty-style.json', import.meta.url)

/** Default cap on resolved images per card — a gallery, not a scrape. */
const DEFAULT_MAX_IMAGES = 12

/** Where an async image node's description lives. */
const QUERY_KEYS = ['query', 'imageQuery', 'describe']

/** Resolver package whose search + cache we borrow. */
const RESOLVER_PKG = '@local/dsh-image-resolver'

/** Hard cap on how long a tool call waits for prefetch; the card still renders after. */
const PREFETCH_BUDGET_MS = 4000

/**
 * Width requested from the resolver. It is sent explicitly (`w=`) on every URL
 * so the route and the prefetch use the SAME cache key — the resolver keys its
 * cache on `width|engine|sources|query`, and a mismatch there turns every
 * prefetch into a cache miss.
 */
const DEFAULT_WIDTH = 900

/** Longest description accepted from a URL, in characters. */
const MAX_QUERY = 300
const MAX_SUBJECT = 200

/**
 * Bytes are PROXIED, not redirected.
 *
 * A 302 hands the browser a third-party URL, and those fail in ways the host
 * cannot see: hotlink protection (403 to a foreign Referer), quotes or spaces
 * in the CDN path, redirect hops Chromium refuses. Fetching here makes the
 * route the only thing the page talks to, so a candidate can be checked and
 * replaced before anything is painted.
 */
const FULL_TIMEOUT_MS = 8000

/** The engine's own thumbnail copy is small and close by; it either answers fast or not at all. */
const THUMB_TIMEOUT_MS = 5000

/**
 * A candidate that has not answered by now gets company: the next one starts
 * alongside it. One slow CDN used to hold a working picture behind a 9 s
 * timeout; downloading every candidate at once would be the other extreme.
 */
const HEDGE_MS = 2500
const PARALLEL_FETCHES = 2

/** Everything a single picture may cost before the route gives up and answers 404. */
const ROUTE_BUDGET_MS = 30000

/** The page-bound last resort runs after the budget above, on its own short leash. */
const BOUND_BUDGET_MS = 12000

/**
 * One answer asks for a dozen pictures at once, and DuckDuckGo/Yandex start
 * answering captchas when a machine fires two dozen searches in a second.
 * Searches queue; downloads do not.
 */
const MAX_PARALLEL_SEARCHES = 6

/** Refuse absurd upstream bodies (a 4K PNG is still ~9 MB). */
const PROXY_MAX_BYTES = 12 * 1024 * 1024

/** Present as the page's own browser; several CDNs 403 an empty UA. */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Square-crop side used when `?fit=square` carries no `?size=`. */
const SQUARE_DEFAULT = 160

/** Version of the candidate matcher; part of every byte cache key, in memory and on disk. */
const BYTE_CACHE_VERSION = 9

/** Lower bound: below a kilobyte it is a sprite, a tracking pixel or an error page. */
const MIN_IMAGE_BYTES = 1024

/**
 * Short side under this is an icon/pixel-mush, not a usable illustration.
 * It is measured from the file header for every format: the old jimp probe
 * could not read WebP, so a 136\u00d777 WebP thumbnail sailed through as "GTA V".
 */
const MIN_IMAGE_SIDE = 200

/** Beyond this aspect ratio the result is a banner or a divider strip. */
const MAX_IMAGE_RATIO = 3.6

/** English queries do not belong in Baidu, Chinese ones do not belong in Bing. */
const CJK_TEXT = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/

/**
 * Search stages ordered by the language of the query.
 *
 * Each stage asks its engines in parallel and pools the hits, so one engine
 * having a bad minute no longer costs the picture; the second stage only runs
 * when nothing from the first could be downloaded. Language still decides the
 * engines: Baidu answers English entity queries with unrelated blog posts \u2014
 * that is how "Mega Houndoom" once became a street photo.
 */
function stagesFor(query, engine) {
  if (engine !== undefined) return [{ engine }]
  /* `bing-cn` is the resolver's own direct cn.bing.com search: a second Bing
     index that kept answering scene queries when www.bing.com served launch
     news for every "GTA 6 …" query and DuckDuckGo answered 403. */
  if (CJK_TEXT.test(query)) {
    return [{ sources: ['baidu', 'so360', 'bing-cn'] }, { sources: ['bing', 'wikimedia'] }]
  }
  return [{ sources: ['bing', 'bing-cn', 'duckduckgo'] }, { sources: ['yandex', 'wikimedia', 'openverse'] }]
}

/** Served bytes, so a repaint does not re-download: full key -> { buf, type, source, at }. */
const byteCache = new Map()

/** How long served bytes stay hot in memory; the disk copy below outlives it. */
const BYTE_TTL_MS = 10 * 60 * 1000

/** Keep the memory cache small enough to live in the plugin process. */
const MAX_BYTE_ENTRIES = 80

/**
 * Pictures that made it to a page, on disk.
 *
 * ChatGPT stores the picture it showed with the message, which is why an old
 * conversation never turns into broken tiles. This is the same promise for
 * DSH: once `(q, s)` produced a verified picture, a restart or a reopened
 * conversation gets that same picture back instead of a new search that may
 * fail or pick something else.
 */
const DISK_DIR = join(homedir(), '.dsh', 'cache', 'async-img')
const DISK_TTL_MS = 30 * 24 * 60 * 60 * 1000
const DISK_MAX_BYTES = 400 * 1024 * 1024
const DISK_PRUNE_EVERY_MS = 10 * 60 * 1000

/** "Nothing verified" is remembered briefly so a re-render does not re-run a 30 s search. */
const MISS_TTL_MS = 3 * 60 * 1000
const MAX_MISS_ENTRIES = 500

/**
 * Big originals are shrunk before they are cached or served: a 4K wallpaper
 * painted into a 150 px gallery tile is several megabytes of nothing.
 */
const SHRINK_OVER_BYTES = 1536 * 1024
const SHRINK_TO_SIDE = 1600

export const name = '@local/dsh-async-ui'

/**
 * `tools` and `webServer` are both optional (a host without either should
 * still load), so they are probed with `ctx.inject` instead of declared.
 */
export const inject = ['systemPrompt']

/**
 * Prompt section: where pictures go in an answer, how many, and how to write them.
 *
 * Measured against ChatGPT on the same GTA question: ChatGPT placed 14
 * pictures in 8 spots — one under every point that described something
 * visible — while DeepSeek counted "core entities", stopped at four in one
 * gallery, and called it the answer's single visual focus. Two things did
 * that, so both are addressed here by name: counting entities instead of
 * points, and the general "fewer components / one focus / would the reader
 * miss it" rules that the model applied to pictures too.
 *
 * This also competes with the image-hunt skill, whose description says
 * "找图/配图" — a model reading that will download files unless this says, in
 * as many words, that a picture inside the reply is a different job from
 * fetching assets.
 */
const SECTION_TEXT = [
  '## 配图策略：按要点配图（图片的唯一规则来源）',
  '优先级：本节优先于 GenUI 技能、TOOLS、个性化设置里所有“组件要少”“焦点唯一”“默认无卡”“删掉这个组件读者会不会更费劲”“不复述正文”“一个主题一个主组件”“宁缺毋滥”之类的通用建议。那些规则只管表格、列表、卡片、图表、callout 这类信息容器，从不约束配图。正文告诉读者“它是什么”，图片告诉读者“它长什么样”，文字替代不了，所以配图永远不算装饰，也不算复述正文。',
  '',
  '### 什么时候配',
  '回答里只要出现能看见的东西，就主动配图，不等用户说“配图”：游戏/影视作品、角色、宝可梦及其形态、地点/建筑/城市、产品/设备、食物、车辆、动植物、艺术作品、活动现场、游戏画面与玩法。',
  '不配图：纯代码、报错、数学推导、纯抽象概念、短翻译、一句话闲聊，或用户明确要纯文字。',
  '',
  '### 放在哪：跟着要点走，一个讲画面的要点一张图',
  '1. 开头：回答围绕某个具体对象时，第一段关键事实后面先放它的一张代表图（官方封面、官方图、实景照）。',
  '2. 每个章节（## 或 ###）：章节第一段后面至少一处配图。',
  '3. 每个要点（编号要点、加粗小标题、一段独立的论述）只要讲的是能看见的东西——外观、地图/地点、角色、玩法画面、战斗、载具、形态差异、使用场景、前后变化——就在这一点的文字后面紧跟一张图，q 写这个画面本身。',
  '4. 一段里并列 3 个以上能看见的东西（多个地点、活动、角色、形态、候选产品）：放一个 image-group，每样一张。',
  '5. 两个对象对比：两边各放一张（image-group 两张并排，或 compare），不能只放其中一方。',
  '6. 正文里一串能看见的东西（“篮球、潜水、划艇、跳伞都能玩”“途经外滩、豫园、陆家嘴”）：紧跟一组图，每样一张。',
  '7. 表格只适合放数字、价格、日期这类短对比；表格里列出的可见变化（舞台、角色、画面、形态），要挑出主要几项另配图，放在表格前后。不要用一张表格代替逐点配图。',
  '同一个对象可以出现多张图，只要画面不同（封面、地图、角色、玩法、细节）；只有同一个画面不重复配。不要把全篇图片集中成开头或结尾的一组。',
  '',
  '### 图组要放足：超出的会叠起来，不占版面',
  'image-group 的显示方式：1 张保持原比例；2 张并排；3 张及以上是“左边一张大图 + 右边上下两张”，只露前 3 张，其余叠在第 3 张上显示总数，点开后可以左右滑动看全部。第 4 张以后不占版面，宿主也只在用户翻到时才去取图。',
  '所以每个图组都要放足：同一主题再补不同画面、角度、细节、场景，常见 6–10 张，最多 24 张；逐个对比的对象组（3 只宝可梦、两代游戏）按对象数放，每个对象可以再补 1–2 张不同画面。回答里的图片总数不设上限。',
  '',
  '一条回答的骨架示例（问“GTA6 相比 GTA5 有什么升级”）：开头结论 → GTA VI 封面一张；「地图」一段 → 一组 6 张（罪恶城夜景、罪恶城海滩、礁岛群、沼泽、港口、山地）；「警察和通缉」一段 → 通缉追捕截图一张；「双主角」一段 → 杰森和露西亚一张；「日常活动」一段（篮球、潜水、划艇）→ 一组 6 张（再补跳伞、健身、钓鱼）；「和 GTA5 对比」→ 表格 + 两代封面并排两张。合计 17 张，分布在 6 处，版面上露出 9 张。',
  '',
  '### 数量：这是下限，不是上限',
  '图片数 ≥ 章节数 + 讲可见事物的要点数。参考：简短回答 2–4 张；常规解释、比较、攻略 6–10 张；多章节长回答 10–20 张，内容需要时更多，总数不设上限。宁可多配一张贴切的图，也不要让一个讲画面的要点空着；全篇只有一组图或只有一处配图，几乎总是配少了。',
  '',
  '### 写法',
  '单张图，紧跟它说明的那个要点：',
  '```dsh-ui',
  '{"items":[{"type":"image","src":"/async-img?q=GTA+6+police+wanted+level+chase+screenshot&s=Grand+Theft+Auto+VI&w=900","caption":"被通缉时的警车追捕"}]}',
  '```',
  '一组图，用于并列的几样东西：',
  '```dsh-ui',
  '{"items":[{"type":"image-group","items":[{"src":"/async-img?q=GTA+6+Vice+City+beach+screenshot&s=Vice+City+GTA+VI&w=900","caption":"罪恶城海滩"},{"src":"/async-img?q=GTA+6+Leonida+Keys+screenshot&s=Leonida+Keys+GTA+VI&w=900","caption":"礁岛群"},{"src":"/async-img?q=GTA+6+swamp+airboat+screenshot&s=Grand+Theft+Auto+VI&w=900","caption":"沼泽里的气垫船"}]}]}',
  '```',
  '- src 一律写 /async-img?q=<检索词>&s=<精确主体>&w=900：宿主负责搜图、核对主体、下载；不要自己猜图片地址，不要先调用 image_hunt 下载文件（只有用户明确要求下载、保存素材时才用 image_hunt / image_download）。',
  '- q 是给搜索引擎的画面描述：主体原名 + 具体画面（official artwork / gameplay screenshot / exterior / product photo / 某个场景）。外国作品、角色、品牌、地名写原名，中文事物写中文；不要把完整问句当检索词。',
  '- s 是必须核对的主体身份，只写准确名称：s=Grand Theft Auto VI。作品里的角色、地点、载具写「名称 + 作品名」：s=Lucia Caminos GTA VI、s=Vice City GTA VI（只写 Vice City 会和 2002 年的旧作混淆）。宝可梦形态写全：s=Mega Houndoom、s=Crowned Shield Zamazenta，不能用普通形态代替。地点写全称：s=深圳市民中心。产品写品牌 + 完整型号和代际。',
  '- 讲玩法、场景、细节的图，s 仍写作品或对象本身，画面差别写进 q：s=Grand Theft Auto VI，q=GTA 6 combat shootout gameplay screenshot。',
  '- caption 写这张图说明的那一点；缩略图不写 alt。',
  '',
  '### 发出前自检（必须做）',
  '把回答的章节和要点逐条过一遍：这一条讲了能看见的东西吗？讲了 → 后面紧跟的图在不在？不在就补上。最后数一遍总图数，低于下限就继续补。',
  '',
  '### 取图失败',
  '宿主会逐个候选核对主体并下载；某张没通过核对就自动不显示，同组其他图照常显示。不要放占位卡、不要写“图片无法加载”、不要在正文解释取图过程，也不要为了凑数换成无关的图。',
].join('\n')


/**
 * A short form of the policy above, placed where the answer gets written.
 *
 * The full policy sits in the system prompt, tens of thousands of characters
 * before the point where the answer is written, while the GenUI skill — loaded
 * mid-turn, so read last — argues for fewer components. DeepSeek Flash follows
 * what it read last. So the reminder rides in three places: with the user's
 * message at the start of a turn, right after the GenUI skill's text, and
 * after a `validate_dsh_ui` check (the model runs it just before emitting its
 * fences). Labelled with its own source kind, like DSH's repeat-tool reminder,
 * so derived history never mistakes it for the user.
 *
 * Never on a bare step: `agent/pre-step` messages are what the step appends to
 * the session, and a turn ends when a step has nothing to append — a reminder
 * on every step kept turns running (2026-11-18, caught within minutes).
 */
const REMINDER_TEXT = [
  '<system-reminder>',
  '配图提醒（宿主自动附加，不是用户的新消息）：这条回答如果会介绍、比较或推荐能看见的东西（作品、角色、地点、产品、宝可梦形态、玩法画面、场景），就按系统提示里「配图策略：按要点配图」来——开头先放一张代表图；每个章节、每个讲到可见事物的要点后面紧跟一张图（dsh-ui 的 image，src 写 /async-img?q=<画面>&s=<主体>&w=900）；并列 3 样以上用一组 image-group；对比的两边都要有图。正文里一串能看见的东西（如“篮球、潜水、划艇都能玩”）和表格里列出的可见变化，也要挑出来配一组图放在旁边。图组只露 3 张（左大右二），其余叠层、点开左右滑动看全部，所以每组要放足：同一主题常见 6–10 张。图片数至少 = 章节数 + 这类要点数，总数不设上限，长回答十几二十张是正常的。「删掉这个组件」「焦点唯一」「不复述正文」「一个主题一个主组件」都不约束配图。纯代码、报错、抽象内容不配图。',
  '</system-reminder>',
].join('\n')

const REMINDER_SOURCE = { kind: 'async-ui-image-reminder', form: 'notice', summary: '配图提醒' }

/** Throttle for the post-validation reminder: one answer validates several fences. */
const VALIDATION_REMINDER_GAP_MS = 5 * 60 * 1000

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** Same shape as the host's createUserMessage: identified, labelled, frozen. */
function reminderMessage() {
  return deepFreeze({
    role: 'user',
    content: [{ type: 'text', text: REMINDER_TEXT }],
    source: { ...REMINDER_SOURCE },
    id: randomUUID(),
  })
}

/** True once our route is serving; meta falls back to /img-resolve when false. */
let routeReady = false

/* What page each resolved picture came from, so the client can show a source
   chip: a picture nobody can trace is a picture nobody can check. */
const sourceCache = new Map()

/** Searches already running, by byte key: the gallery tile and its lightbox share one. */
const inflight = new Map()

/** Byte keys that recently found nothing verified: key -> at. */
const missCache = new Map()

/**
 * Pictures recently served, by content hash -> { key, at }, where key is the
 * request's `s` + `q`.
 *
 * Two requests of one answer can resolve to the same picture: GTA VI's
 * character pages all lead with the same Jason-and-Lucia key art, and with
 * per-point illustration "GTA 6 police chase", "GTA 6 combat" and "GTA 6
 * airboat" share the subject Grand Theft Auto VI, whose official page leads
 * with the cover. A picture already given to another request is passed over
 * for that request's next candidate.
 */
const recentPictures = new Map()
const RECENT_PICTURE_TTL_MS = 10 * 60 * 1000
const MAX_RECENT_PICTURES = 400

/** One shared promise for the resolver module (undefined until first use). */
let resolverState = { stamp: '', promise: undefined }

/** Read a non-empty string. */
function pickString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function sourceKey(width, query, subject = query) {
  return String(width) + '|' + subject + '|' + query
}

/** Clamp `?w=` the way the resolver does, so both sides agree on the key. */
function clampWidth(raw) {
  const value = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(value)) return DEFAULT_WIDTH
  return Math.min(2048, Math.max(320, value))
}

/** Build the async image URL for one description. */
function resolveUrl(query, options, subject = query) {
  const width = options.width ?? DEFAULT_WIDTH
  const base = routeReady ? ROUTE : FALLBACK_ROUTE
  const params = new URLSearchParams({ q: query, s: subject, w: String(width) })
  if (options.engine) params.set('engine', options.engine)
  return base + '?' + params.toString()
}

/**
 * Import the resolver package so searches and caching are its concern, not
 * ours.
 *
 * The plugin is linked into the profile, so pnpm puts a symlink in the
 * profile's `node_modules`; resolving from there works even though this
 * package does not declare it as a dependency (same trick the resolver uses
 * for `dsh-image-hunt`). A profile without the resolver simply gets a route
 * that 302s to whatever exists, or a 404.
 */
function resolverTarget() {
  const bases = [
    process.env.DSH_PROFILE_DIR,
    join(homedir(), '.dsh', 'profiles', 'desktop'),
    process.cwd(),
  ].filter(base => typeof base === 'string' && base !== '')
  for (const base of bases) {
    try {
      const require = createRequire(join(base, 'package.json'))
      const path = require.resolve(RESOLVER_PKG)
      return { url: pathToFileURL(path).href, stamp: String(statSync(path).mtimeMs) }
    } catch {
      /* try the next base */
    }
  }
  return undefined
}

/**
 * Load the resolver, re-importing it when the file on disk changes.
 *
 * Node keys ES modules by specifier, so a plain `import()` pins the first
 * version for the life of the process: editing the resolver and reloading this
 * plugin would keep running the old code. The mtime query gives each version
 * its own specifier, which is what makes "edit → reload → test" work without
 * restarting DSH.
 */
function loadResolver() {
  let target
  try {
    target = resolverTarget()
  } catch {
    target = undefined
  }
  if (target === undefined) return Promise.resolve(undefined)
  const stamp = `${target.url}@${target.stamp}`
  if (resolverState.promise !== undefined && resolverState.stamp === stamp) return resolverState.promise
  resolverState = {
    stamp,
    promise: import(`${target.url}?v=${encodeURIComponent(target.stamp)}`).catch(() => undefined),
  }
  return resolverState.promise
}

/**
 * Ask the resolver for every candidate whose title/page actually names the
 * subject, best first. Older resolver builds only export the single-candidate
 * call, hence the feature check.
 */
async function resolveCandidates(query, width, stage, extra) {
  const module = await loadResolver()
  if (module === undefined) return []
  const opts = { ...extra }
  if (stage.engine !== undefined) opts.engine = stage.engine
  if (Array.isArray(stage.sources) && stage.sources.length > 0) opts.sources = stage.sources
  if (typeof module.resolveImageCandidates === 'function') return await module.resolveImageCandidates(query, width, opts)
  if (typeof module.resolveImageCandidate !== 'function') return []
  const one = await module.resolveImageCandidate(query, width, opts)
  return one === undefined ? [] : [one]
}

/** Page-bound resolution: the page names the subject, its lead image illustrates it. */
async function resolveBound(query, subject = query) {
  const module = await loadResolver()
  if (module === undefined || typeof module.resolvePageImage !== 'function') return undefined
  return await module.resolvePageImage(query, { subject })
}

/**
 * Resolve every description before the card is handed back.
 *
 * Without this the browser's first request carries the whole search (0.7–1.5 s
 * cold) and the user stares at an empty box. Cost is bounded: the tool call
 * waits at most PREFETCH_BUDGET_MS, and work still in flight keeps filling the
 * cache for the next card. It goes through `obtainImage`, the route's own
 * path, so a prefetched picture is one the route would have served anyway.
 *
 * @returns `{ warm, total }` for the tool result line.
 */
async function prefetch(queries, options) {
  const width = options.width ?? DEFAULT_WIDTH
  let warm = 0
  const work = Promise.all(queries.map(async (item) => {
    const query = typeof item === 'string' ? item : item.query
    const subject = typeof item === 'string' ? item : item.subject ?? item.query
    try {
      const found = await obtainImage({ query, subject, width, engine: options.engine })
      if (found !== undefined) warm += 1
    } catch {
      /* The live route searches again on its own. */
    }
  }))
  await Promise.race([work, new Promise(resolve => { setTimeout(resolve, PREFETCH_BUDGET_MS).unref?.() })])
  return { warm, total: queries.length }
}

/**
 * Rewrite description-carrying image nodes into URL-carrying ones.
 *
 * A node is an async image when it has one of QUERY_KEYS and NO explicit
 * source. It does not need `type: "image"` — image-group `items` and
 * compare `before`/`after` are bare `{src, alt}` records, so field shape is
 * the only reliable test across components.
 *
 * @param spec - the model-authored GenUI spec (must already be an object).
 * @param options - `maxImages`, `width`, `engine`.
 * @returns the rewritten spec plus resolve statistics.
 */
export function resolveSpec(spec, options = {}) {
  const maxImages = Number.isFinite(options.maxImages) ? options.maxImages : DEFAULT_MAX_IMAGES
  const stats = { resolved: 0, skipped: 0, queries: [] }

  const visit = (value) => {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(visit)
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = visit(child)
    const query = QUERY_KEYS.map(key => pickString(value[key])).find(Boolean)
      ?? QUERY_KEYS.map(key => pickString(out[key])).find(Boolean)
    const subject = pickString(value.subject) ?? pickString(out.subject) ?? query
    const hasSource = pickString(out.src) !== undefined
      || pickString(out.image) !== undefined
      || pickString(out.poster) !== undefined
    if (query !== undefined && !hasSource) {
      if (stats.resolved >= maxImages) {
        stats.skipped += 1
        return out
      }
      out.src = resolveUrl(query, options, subject)
      for (const key of QUERY_KEYS) delete out[key]
      delete out.subject
      stats.resolved += 1
      if (!stats.queries.some(item => item.query === query && item.subject === subject)) {
        stats.queries.push({ query, subject })
      }
    }
    return out
  }

  return { spec: visit(spec), stats }
}

/** Profile bases that may hold `jimp`, same lookup order the resolver uses. */
function profileBases() {
  return [
    process.env.DSH_PROFILE_DIR,
    join(homedir(), '.dsh', 'profiles', 'desktop'),
    process.cwd(),
  ].filter(base => typeof base === 'string' && base !== '')
}

/** One shared import of jimp; a profile without it just loses square crops. */
let jimpPromise
function loadJimp() {
  if (jimpPromise === undefined) {
    jimpPromise = (async () => {
      for (const base of profileBases()) {
        try {
          const require = createRequire(join(base, 'package.json'))
          return await import(require.resolve('jimp'))
        } catch {
          /* try the next base */
        }
      }
      return undefined
    })()
  }
  return jimpPromise
}

/**
 * Format and pixel size from the file header, for every format Chromium paints.
 *
 * Magic bytes beat a lying Content-Type, and reading the size here (instead of
 * decoding with jimp, which cannot open WebP) means the size floor applies to
 * every picture — the old probe waved a 136×77 WebP thumbnail through. SVG and
 * HEIC are refused on purpose: no size to check, or no way to paint it.
 *
 * @returns `{ type, width, height }`, or undefined when it is not a raster image.
 */
function imageInfo(buf) {
  if (buf.length < 32) return undefined
  if (buf.readUInt32BE(0) === 0x89504e47) {
    return { type: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') {
    return { type: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue }
      const marker = buf[i + 1]
      if (marker === 0xff) { i += 1; continue }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue }
      if (marker === 0xd9 || marker === 0xda) break
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'image/jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
      }
      i += 2 + buf.readUInt16BE(i + 2)
    }
    return undefined
  }
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buf.subarray(12, 16).toString('ascii')
    if (chunk === 'VP8X') return { type: 'image/webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
    if (chunk === 'VP8 ') return { type: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21)
      return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return undefined
  }
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const box = buf.subarray(8, Math.min(buf.length, buf.readUInt32BE(0)))
    if (!/avi[fs]/.test(box.toString('latin1'))) return undefined
    /* Every AVIF item carries an `ispe` box; the largest one is the picture,
       the smaller ones are its alpha plane or thumbnail. */
    const head = buf.subarray(0, Math.min(buf.length, 65536))
    let width = 0
    let height = 0
    for (let at = head.indexOf('ispe'); at !== -1 && at + 16 <= head.length; at = head.indexOf('ispe', at + 4)) {
      const w = head.readUInt32BE(at + 8)
      const h = head.readUInt32BE(at + 12)
      if (w * h > width * height) { width = w; height = h }
    }
    return width > 0 ? { type: 'image/avif', width, height } : undefined
  }
  if (buf.subarray(0, 2).toString('ascii') === 'BM') {
    return { type: 'image/bmp', width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) }
  }
  return undefined
}

/** Merge an outer abort (another candidate won) with a per-request timeout. */
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/**
 * Download one URL and prove it is a picture worth painting.
 *
 * Referer: the page the picture was found on is what its own site sends, so
 * that goes first. Hotlink rules that only tolerate an empty Referer answer
 * 401/403 to it — those get exactly one retry without one.
 */
async function fetchImageBytes(url, referer, timeout, signal) {
  const get = (withReferer) => fetch(url, {
    redirect: 'follow',
    signal: withTimeout(signal, timeout),
    headers: {
      'user-agent': BROWSER_UA,
      accept: 'image/avif,image/webp,image/apng,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5',
      ...(withReferer !== undefined ? { referer: withReferer } : {}),
    },
  })
  let response = await get(referer)
  if ((response.status === 401 || response.status === 403) && referer !== undefined) {
    response.body?.cancel().catch(() => {})
    response = await get(undefined)
  }
  if (!response.ok) throw new Error(`upstream ${response.status}`)
  const hint = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (hint !== '' && !hint.startsWith('image/') && !hint.startsWith('binary/') && hint !== 'application/octet-stream') {
    response.body?.cancel().catch(() => {})
    throw new Error(`upstream type ${hint}`)
  }
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > PROXY_MAX_BYTES) {
    response.body?.cancel().catch(() => {})
    throw new Error(`upstream body ${declared}B (too large)`)
  }
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.length < MIN_IMAGE_BYTES) throw new Error(`upstream body ${buf.length}B`)
  if (buf.length > PROXY_MAX_BYTES) throw new Error(`upstream body ${buf.length}B (too large)`)
  const info = imageInfo(buf)
  if (info === undefined) throw new Error('upstream body is not a raster image')
  /* Reject sprite-sized and banner-shaped results: they read as artifacts. */
  const shortSide = Math.min(info.width, info.height)
  if (shortSide < MIN_IMAGE_SIDE) throw new Error(`upstream ${info.width}x${info.height} too small`)
  if (Math.max(info.width, info.height) / Math.max(1, shortSide) > MAX_IMAGE_RATIO) {
    throw new Error(`upstream ${info.width}x${info.height} too wide`)
  }
  return { buf, type: info.type, info }
}

/** Only the page a picture came from is a sensible Referer; Baidu's obfuscated paths are not URLs. */
function pageReferer(candidate) {
  return typeof candidate.page === 'string' && /^https?:\/\//i.test(candidate.page) ? candidate.page : undefined
}

/**
 * One candidate, original first and the engine's thumbnail second.
 *
 * The thumbnail is the same picture held by the search engine's own CDN
 * (Bing `th?id=`, Baidu `img*.baidu.com`, 360 `qhimgs`), which does not care
 * who links to it. When the original sits behind hotlink protection, a dead
 * link or a slow server, the thumbnail is what keeps the tile from breaking.
 */
async function fetchVerified(candidate, signal) {
  let url = candidate.url
  if (candidate.kind === 'page') {
    /* A page candidate (official page, trusted article) names the picture
       only through its own lead image, looked up now rather than during the
       search so a slow article never held the other candidates back. */
    const module = await loadResolver()
    url = typeof module?.pageLeadImage === 'function' ? await module.pageLeadImage(candidate.page) : undefined
    if (url === undefined) throw new Error('page declares no lead image')
    if (signal?.aborted) throw new Error('aborted')
  }
  try {
    return { ...(await fetchImageBytes(url, pageReferer(candidate), FULL_TIMEOUT_MS, signal)), via: candidate.kind === 'page' ? 'page' : 'full' }
  } catch (error) {
    if (signal?.aborted || typeof candidate.thumb !== 'string') throw error
    try {
      return { ...(await fetchImageBytes(candidate.thumb, candidate.referer, THUMB_TIMEOUT_MS, signal)), via: 'thumb' }
    } catch {
      throw error
    }
  }
}

/**
 * Try candidates in rank order and settle on the first one that downloads.
 *
 * Strictly serial lets one slow CDN hold a working picture behind it; strictly
 * parallel downloads every candidate. In between: when the running attempt has
 * not finished within HEDGE_MS the next one starts beside it (at most
 * PARALLEL_FETCHES at a time), and the first success aborts the rest.
 */
function firstWorking(candidates, deadline, failures, accept = () => true) {
  const controller = new AbortController()
  return new Promise((resolve) => {
    let next = 0
    let running = 0
    let done = false
    const settle = (value) => {
      if (done) return
      done = true
      controller.abort()
      resolve(value)
    }
    const launch = () => {
      if (done) return
      if (next >= candidates.length || Date.now() >= deadline) {
        if (running === 0) settle(undefined)
        return
      }
      const candidate = candidates[next]
      next += 1
      running += 1
      const hedge = setTimeout(() => { if (running < PARALLEL_FETCHES) launch() }, HEDGE_MS)
      fetchVerified(candidate, controller.signal).then(
        bytes => ({ candidate, ...bytes }),
        (error) => {
          if (!done) failures.push(`${candidate.engine || 'candidate'}: ${String(error?.message ?? error).slice(0, 90)}`)
          return undefined
        },
      ).then((hit) => {
        clearTimeout(hedge)
        running -= 1
        if (hit !== undefined && !done && accept(hit)) settle(hit)
        else launch()
      })
    }
    launch()
  })
}

/** A tiny FIFO semaphore: at most `max` tasks run, the rest wait their turn. */
function limiter(max) {
  let active = 0
  const queue = []
  const pump = () => {
    while (active < max && queue.length > 0) {
      const { task, resolve, reject } = queue.shift()
      active += 1
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        active -= 1
        pump()
      })
    }
  }
  return task => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject })
    pump()
  })
}

const searchSlot = limiter(MAX_PARALLEL_SEARCHES)

const execFileAsync = promisify(execFile)

/**
 * Center-crop to a square through macOS `sips`.
 *
 * jimp 1.x cannot decode WebP, and WebP is a large share of Chinese search
 * results, so the platform tool is the fallback rather than shipping a wasm
 * decoder. `sips` crops from the centre and writes JPEG.
 */
async function sipsSquare(bytes, size) {
  const dir = await mkdtemp(join(tmpdir(), 'async-ui-'))
  try {
    const source = join(dir, 'in.img')
    const scaled = join(dir, 'scaled.jpg')
    const target = join(dir, 'out.jpg')
    await writeFile(source, bytes.buf)
    // `--cropToHeightWidth` is a pixel crop, not a cover: cropping a 1280px
    // WebP to 200px keeps the centre 200px square, which is a 6x zoom into the
    // middle of the picture. Scale so the short side equals `size` first, then
    // the centre crop is the same "cover" jimp does.
    const { stdout } = await execFileAsync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', source])
    const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1])
    const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1])
    if (width > 0 && height > 0) {
      const long = Math.round((Math.max(width, height) * size) / Math.min(width, height))
      if (Math.abs(long - Math.max(width, height)) > 1) {
        // Convert on the way out: `sips` keeps the source format, and a WebP
        // destination is not writable ("Can't write format: org.webmproject.webp").
        await execFileAsync('sips', ['-s', 'format', 'jpeg', '-Z', String(long), source, '--out', scaled])
        await execFileAsync('sips', ['-s', 'format', 'jpeg', '--cropToHeightWidth', String(size), String(size), scaled, '--out', target])
        const buf = await readFile(target)
        if (buf.length < MIN_IMAGE_BYTES) return undefined
        return { buf, type: 'image/jpeg' }
      }
    }
    await execFileAsync('sips', ['-s', 'format', 'jpeg', '--cropToHeightWidth', String(size), String(size), source, '--out', target])
    const buf = await readFile(target)
    if (buf.length < MIN_IMAGE_BYTES) return undefined
    return { buf, type: 'image/jpeg' }
  } catch {
    return undefined
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Center-crop to a square so a thumbnail column never staggers. */
async function squareCrop(bytes, size) {
  const jimp = await loadJimp()
  if (jimp !== undefined) {
    try {
      const image = await jimp.Jimp.read(bytes.buf)
      image.cover({ w: size, h: size })
      const buf = await image.getBuffer('image/jpeg', { quality: 82 })
      return { buf: Buffer.from(buf), type: 'image/jpeg' }
    } catch {
      /* WebP and friends: fall through to the platform tool. */
    }
  }
  if (process.platform === 'darwin') return await sipsSquare(bytes, size)
  return undefined
}

/**
 * Shrink a big JPEG/PNG to SHRINK_TO_SIDE through macOS `sips`, keeping the
 * format (a PNG keeps its transparency). Anything else, or any failure,
 * returns the original bytes: a large picture is still a picture.
 */
async function shrinkLarge(bytes, info) {
  if (process.platform !== 'darwin' || info === undefined) return bytes
  if (bytes.buf.length < SHRINK_OVER_BYTES || Math.max(info.width, info.height) <= SHRINK_TO_SIDE) return bytes
  if (bytes.type !== 'image/jpeg' && bytes.type !== 'image/png') return bytes
  const ext = bytes.type === 'image/png' ? 'png' : 'jpg'
  const dir = await mkdtemp(join(tmpdir(), 'async-ui-'))
  try {
    const source = join(dir, `in.${ext}`)
    const target = join(dir, `out.${ext}`)
    await writeFile(source, bytes.buf)
    const quality = ext === 'jpg' ? ['-s', 'formatOptions', '85'] : []
    await execFileAsync('sips', ['-Z', String(SHRINK_TO_SIDE), ...quality, source, '--out', target], { timeout: 8000 })
    const buf = await readFile(target)
    if (buf.length < MIN_IMAGE_BYTES || buf.length >= bytes.buf.length || imageInfo(buf) === undefined) return bytes
    return { buf, type: bytes.type }
  } catch {
    return bytes
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Park served bytes so the next repaint is free. */
function rememberBytes(key, bytes) {
  if (byteCache.size >= MAX_BYTE_ENTRIES) {
    const oldest = byteCache.keys().next().value
    if (oldest !== undefined) byteCache.delete(oldest)
  }
  byteCache.set(key, { buf: bytes.buf, type: bytes.type, source: bytes.source, at: Date.now() })
}

function cachedBytes(key) {
  const hit = byteCache.get(key)
  if (hit === undefined || Date.now() - hit.at > BYTE_TTL_MS) return undefined
  return hit
}

function rememberMiss(key) {
  if (missCache.size >= MAX_MISS_ENTRIES) {
    const oldest = missCache.keys().next().value
    if (oldest !== undefined) missCache.delete(oldest)
  }
  missCache.set(key, Date.now())
}

function recentMiss(key) {
  const at = missCache.get(key)
  if (at === undefined) return false
  if (Date.now() - at > MISS_TTL_MS) {
    missCache.delete(key)
    return false
  }
  return true
}

/* ---------------- disk cache ---------------- */

function diskBase(key) {
  return join(DISK_DIR, createHash('sha256').update(key).digest('hex').slice(0, 40))
}

/** A stored picture, or undefined when absent, expired, or written by another matcher. */
async function readDisk(key) {
  const base = diskBase(key)
  try {
    const meta = JSON.parse(await readFile(base + '.json', 'utf8'))
    if (meta.key !== key || Date.now() - Number(meta.at) > DISK_TTL_MS) return undefined
    const buf = await readFile(base + '.img')
    if (buf.length !== meta.size || imageInfo(buf) === undefined) return undefined
    return { buf, type: meta.type, source: meta.source }
  } catch {
    return undefined
  }
}

/** Write bytes first and the index last, so a reader never trusts a half-written picture. */
async function writeDisk(key, bytes) {
  await mkdir(DISK_DIR, { recursive: true })
  const base = diskBase(key)
  const tmp = `${base}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, bytes.buf)
  await rename(tmp, base + '.img')
  await writeFile(base + '.json', JSON.stringify({
    key, type: bytes.type, size: bytes.buf.length, at: Date.now(), source: bytes.source,
  }))
  pruneDiskSoon()
}

let lastPrune = 0

/** Drop expired pictures, then the oldest ones until the folder fits DISK_MAX_BYTES. */
function pruneDiskSoon() {
  if (Date.now() - lastPrune < DISK_PRUNE_EVERY_MS) return
  lastPrune = Date.now()
  ;(async () => {
    const names = (await readdir(DISK_DIR)).filter(name => name.endsWith('.img'))
    const files = []
    for (const name of names) {
      try {
        const info = await stat(join(DISK_DIR, name))
        files.push({ base: join(DISK_DIR, name.slice(0, -4)), size: info.size, at: info.mtimeMs })
      } catch {
        /* raced with another prune */
      }
    }
    files.sort((a, b) => a.at - b.at)
    let total = files.reduce((sum, file) => sum + file.size, 0)
    for (const file of files) {
      if (total <= DISK_MAX_BYTES && Date.now() - file.at <= DISK_TTL_MS) continue
      await unlink(file.base + '.img').catch(() => {})
      await unlink(file.base + '.json').catch(() => {})
      total -= file.size
    }
  })().catch(() => {})
}

/* ---------------- one picture, from the cheapest place that has it ---------------- */

/** Bump BYTE_CACHE_VERSION when the matcher changes: cached bytes must not outlive a fix. */
function byteKeyOf({ query, subject, width, engine, fit, size }) {
  return [BYTE_CACHE_VERSION, width, engine ?? '', fit ?? '', size ?? '', subject, query].join('|')
}

/** Which request a served picture belongs to: subject and scene both count. */
function pictureKey({ subject, query }) {
  return `${subject}\n${query}`
}

/** Remember that the request `key` was shown the picture with this hash. */
function notePicture(hash, key) {
  if (typeof hash !== 'string') return
  recentPictures.delete(hash)
  recentPictures.set(hash, { key, at: Date.now() })
  if (recentPictures.size > MAX_RECENT_PICTURES) recentPictures.delete(recentPictures.keys().next().value)
}

/**
 * Claim a downloaded picture for the request `key`, unless another request
 * was shown it moments ago. Check and claim happen in one synchronous step,
 * so two concurrent requests cannot both take the same picture.
 */
function claimPicture(hit, key) {
  hit.hash = createHash('sha1').update(hit.buf).digest('hex')
  const prior = recentPictures.get(hit.hash)
  if (prior !== undefined && prior.key !== key && Date.now() - prior.at < RECENT_PICTURE_TTL_MS) return false
  notePicture(hit.hash, key)
  return true
}

/** Record where a served picture came from, for /async-img-meta. Only titles that named the subject get here. */
function noteSource({ query, subject, width }, source) {
  if (source === undefined || typeof source.title !== 'string' || source.title === '') return
  sourceCache.set(sourceKey(width, query, subject), {
    query, subject, title: source.title, page: source.page, engine: source.engine ?? null, at: Date.now(),
  })
}

/** Crop or shrink a downloaded hit into what the route serves and caches. */
async function finishHit(hit, request, from) {
  let bytes = { buf: hit.buf, type: hit.type }
  if (request.fit === 'square' && request.size !== undefined) bytes = (await squareCrop(bytes, request.size)) ?? bytes
  else bytes = await shrinkLarge(bytes, hit.info)
  const { candidate } = hit
  return {
    ...bytes,
    from,
    via: hit.via,
    source: { title: candidate.title, page: candidate.page, engine: candidate.engine, tier: candidate.tier, hash: hit.hash },
  }
}

/**
 * Search, verify and download one picture.
 *
 * Stage after stage, every verified candidate is tried — original, then the
 * engine's thumbnail — before the next stage is even searched. Page binding
 * (official page, Wikipedia lead image, a trusted article's og:image) is slow
 * and rarely needed, so it starts only when the first stage came back empty
 * and runs alongside the second.
 */
async function searchAndFetch(request) {
  const { query, subject, width, engine, fit, size } = request
  const deadline = Date.now() + ROUTE_BUDGET_MS
  const failures = []
  const tried = new Set()
  const extra = { subject, ...(fit === 'square' && size !== undefined ? { minPixels: size } : {}) }
  const accept = hit => claimPicture(hit, pictureKey(request))
  const stages = stagesFor(query, engine)
  let bound
  for (let index = 0; index < stages.length && Date.now() < deadline; index += 1) {
    if (index === 1) bound = resolveBound(query, subject).catch(() => undefined)
    let candidates
    try {
      candidates = await searchSlot(() => resolveCandidates(query, width, stages[index], extra))
    } catch (error) {
      failures.push(`search: ${String(error).slice(0, 90)}`)
      continue
    }
    const fresh = candidates.filter(candidate => typeof candidate?.url === 'string' && !tried.has(candidate.url))
    for (const candidate of fresh) tried.add(candidate.url)
    const hit = await firstWorking(fresh, deadline, failures, accept)
    if (hit !== undefined) return await finishHit(hit, request, index === 0 ? 'resolved' : 'source-fallback')
  }
  const page = await (bound ?? resolveBound(query, subject).catch(() => undefined))
  if (page !== undefined && typeof page.url === 'string' && !tried.has(page.url)) {
    const hit = await firstWorking([page], Date.now() + BOUND_BUDGET_MS, failures, accept)
    if (hit !== undefined) return await finishHit(hit, request, 'source-fallback')
  }
  if (process.env.ASYNC_UI_DEBUG === '1') console.error('[async-ui] no picture for %o: %o', subject, failures)
  return undefined
}

/**
 * One picture for one `(q, s, w, fit, size)`, from the cheapest place that has it.
 *
 * Memory, then disk, then a search already running for the same key, then a
 * recent "nothing verified", and only then a fresh search. Every cache is fed
 * by `searchAndFetch` alone, so a cache can only ever hold a picture that
 * decoded, was big enough and named the subject.
 */
function obtainImage(request) {
  const key = byteKeyOf(request)
  const hot = cachedBytes(key)
  if (hot !== undefined) {
    notePicture(hot.source?.hash, pictureKey(request))
    return Promise.resolve({ ...hot, from: 'warm' })
  }
  const running = inflight.get(key)
  if (running !== undefined) return running
  const job = (async () => {
    const stored = await readDisk(key)
    if (stored !== undefined) {
      rememberBytes(key, stored)
      noteSource(request, stored.source)
      notePicture(stored.source?.hash, pictureKey(request))
      return { ...stored, from: 'disk' }
    }
    if (recentMiss(key)) return undefined
    const found = await searchAndFetch(request)
    if (found === undefined) {
      rememberMiss(key)
      return undefined
    }
    rememberBytes(key, found)
    noteSource(request, found.source)
    writeDisk(key, found).catch(() => {})
    return found
  })().finally(() => inflight.delete(key))
  inflight.set(key, job)
  return job
}

/**
 * GET /async-img?q=…&s=…[&w=900][&engine=baidu][&fit=square][&size=160]
 *
 * Proxies the bytes instead of redirecting, so every candidate is checked
 * before the page sees it and a 403/hotlink/CDN quirk falls through to the
 * next candidate instead of painting a broken image. Nothing verified answers
 * 404 and the card renderer drops the tile — no placeholder picture.
 */
async function serveAsyncImage(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  let parsed
  try {
    parsed = new URL(req.url ?? '/', 'http://local')
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  const query = (parsed.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY)
  if (query === '') {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('missing ?q= (image description)')
    return
  }
  const subject = (parsed.searchParams.get('s') ?? parsed.searchParams.get('subject') ?? query).trim().slice(0, MAX_SUBJECT)
  const width = clampWidth(parsed.searchParams.get('w'))
  const engine = parsed.searchParams.get('engine') ?? undefined
  const fit = parsed.searchParams.get('fit') === 'square' ? 'square' : undefined
  const size = fit === 'square'
    ? Math.min(512, Math.max(48, Number.parseInt(parsed.searchParams.get('size') ?? '', 10) || SQUARE_DEFAULT))
    : undefined
  const bytes = await obtainImage({ query, subject, width, engine, fit, size })

  if (bytes === undefined) {
    /* Nothing checked out. Answer 404 so the <img> fires `error` and the card
       renderer drops the tile: a "no verified picture" card is still a card the
       reader has to look at, and it reads as a broken slot. A random search hit
       is not the alternative either — that is how the wrong picture got in.
       Verified or nothing means nothing here, not a placeholder. */
    res.writeHead(404, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-async-ui': 'unverified',
      'x-async-ui-placeholder': '1',
      'x-async-ui-build': String(BYTE_CACHE_VERSION),
    })
    if (req.method === 'HEAD') res.end()
    else res.end('no verified picture for q=' + query + ' subject=' + subject)
    return
  }

  const source = bytes.source ?? {}
  const page = typeof source.page === 'string' && /^https?:\/\//i.test(source.page) ? source.page : undefined
  res.writeHead(200, {
    'content-type': bytes.type,
    'content-length': String(bytes.buf.length),
    /* Ten minutes in the browser, never longer: the gallery warms its stacked
       pictures in the background, and with no-store the viewer downloaded each
       one a second time. A URL keeps its picture for 30 days in the host's disk
       cache anyway; a short browser copy cannot outlive a resolver fix by long. */
    'cache-control': 'private, max-age=600',
    'x-async-ui': bytes.from,
    'x-async-ui-build': String(BYTE_CACHE_VERSION),
    /* Which prompt policy this build injects; a quick check that a reload took. */
    'x-async-ui-policy': 'per-point',
    ...(bytes.via === undefined ? {} : { 'x-async-ui-via': bytes.via }),
    ...(fit === 'square' ? { 'x-async-ui-fit': `square${size}` } : {}),
    ...(typeof source.title === 'string' && source.title !== ''
      ? { 'x-async-ui-match': encodeURIComponent(source.title.slice(0, 120)) }
      : { 'x-async-ui-match': 'unverified' }),
    ...(page === undefined ? {} : { 'x-async-ui-page': encodeURIComponent(page.slice(0, 200)) }),
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(bytes.buf)
}

/**
 * Report where one resolved picture came from.
 *
 * The client decorates every `/async-img` picture with a small source line, so
 * a wrong picture is visibly tied to a wrong page instead of being an
 * unverifiable claim. Answers `{}` when the picture was never verified.
 */
function serveMeta(req, res) {
  const parsed = new URL(req.url ?? '/', 'http://localhost')
  const query = (parsed.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY)
  const subject = (parsed.searchParams.get('s') ?? parsed.searchParams.get('subject') ?? query).trim().slice(0, MAX_SUBJECT)
  const width = clampWidth(parsed.searchParams.get('w'))
  const hit = query === '' ? undefined : sourceCache.get(sourceKey(width, query, subject))
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  /* Baidu reports its source pages as obfuscated paths, not URLs: a href built
     from one would be a lie, so only a real URL becomes a link. */
  const page = typeof hit?.page === 'string' && /^https?:\/\//i.test(hit.page) ? hit.page : null
  res.end(JSON.stringify(hit === undefined ? {} : {
    query: hit.query,
    title: hit.title,
    page,
    engine: hit.engine ?? null,
  }))
}

/**
 * Read the `spec` argument defensively.
 *
 * The tool-call bridge has been observed delivering `{ spec: <object> }`,
 * `{ spec: "<JSON>" }`, `{ arguments: … }` and bare strings; the authored
 * shape is unwrapped here so the rewrite always sees the real tree.
 */
function specOf(args) {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args)
    } catch {
      return undefined
    }
  }
  if (args === null || typeof args !== 'object') return undefined
  const record = args
  let value = 'spec' in record ? record.spec : 'arguments' in record ? record.arguments : record
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch {
        return undefined
      }
    }
    if (value !== null && typeof value === 'object' && 'spec' in value) {
      value = value.spec
      continue
    }
    break
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** Card title shared by the pending and settled presentations. */
function titleOf(args) {
  const spec = specOf(args)
  const title = spec === null || spec === undefined ? undefined : pickString(spec.title)
  return title ?? '未命名'
}

/** Arguments: one open `spec` slot (the guard, not the schema, is authority). */
const PARAMETERS = {
  type: 'object',
  properties: {
    spec: {
      type: 'object',
      description: [
        'GenUI spec to render as a card in the tool row. Same white-listed vocabulary as the dsh-ui fence.',
        'ASYNC IMAGES: instead of a real URL, an image node may carry `query` (a natural-language description such as "赛博朋克夜景 城市 霓虹").',
        'The host resolves every query into a real image and rewrites the node before rendering — one call, no manual image search.',
        'Nodes that already carry `src` are left untouched, so local screenshots (/api/file?path=…) and known URLs keep working.',
        'Applies to `image`, `image-group` items, and `compare` before/after (any `{src}` record with a query field).',
      ].join(' '),
      properties: {
        title: { type: 'string', description: 'Short title shown as the card banner.' },
        gap: { type: 'number', description: 'Vertical gap between root items in px.' },
        items: {
          type: 'array',
          description: 'Root component list (white-listed GenUI vocabulary).',
          items: { type: 'object' },
        },
      },
    },
  },
  required: ['spec'],
  additionalProperties: false,
}

/**
 * Tool definition kept for reference: `render_ui` is NOT registered any more.
 * The fence path is the only one — a tool result lands in the collapsed tool
 * row (“面板”), which is exactly what the user rejected.
 */
function createAsyncRenderTool(config = {}) {
  const options = {
    maxImages: config.maxImages,
    width: config.width,
    engine: typeof config.engine === 'string' ? config.engine : undefined,
  }

  return {
    name: 'render_ui',
    description:
      'Render an interactive UI card in the conversation tool row. Same GenUI vocabulary as the dsh-ui fence, plus ASYNC IMAGES: '
      + 'give an image node `query` (a description) instead of `src` and the host resolves it to a real picture — use this for '
      + '“illustrate this with a photo of X”, covers, mood boards and galleries where you do not have a URL. '
      + 'Existing src values (https URLs, /api/file?path=… local screenshots) are never touched. '
      + 'The card is interactive client-side; components carrying an "action" field send [genui-action] back to you, and you should re-render.',
    parameters: PARAMETERS,
    output: {
      schema: { type: 'string', description: 'One-line render summary for the model.' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      },
      presentationMeta(args) {
        const spec = specOf(args)
        if (spec === undefined) return null
        const { spec: resolved } = resolveSpec(spec, options)
        return resolved
      },
    },
    async execute(args) {
      const spec = specOf(args)
      if (spec === undefined) {
        return ['[async-ui]', 'status=invalid', 'error=spec_not_an_object', 'next=fix_and_retry', 'reply_language=conversation'].join('\n')
      }
      if (!Array.isArray(spec.items)) {
        return ['[async-ui]', 'status=invalid', 'error=items_required', 'next=fix_and_retry', 'reply_language=conversation'].join('\n')
      }
      const { stats } = resolveSpec(spec, options)
      const pre = stats.queries.length > 0
        ? await prefetch(stats.queries, options)
        : { warm: 0, total: 0 }
      return [
        '[async-ui]',
        'status=rendered',
        `images=${stats.resolved}`,
        ...(pre.total > 0 ? [`prefetch=${pre.warm}/${pre.total}`] : []),
        ...(stats.skipped > 0 ? [`skipped=${stats.skipped}`, `max_images=${options.maxImages ?? DEFAULT_MAX_IMAGES}`] : []),
        `resolve_route=${routeReady ? ROUTE : FALLBACK_ROUTE}`,
        'reply_language=conversation',
      ].join('\n')
    },
    presentCall(args) {
      return { card: 'generic', title: `渲染 UI：${titleOf(args)}`, kind: 'other' }
    },
    presentResult(args) {
      return { card: 'generic', title: `渲染 UI：${titleOf(args)}` }
    },
  }
}

/**
 * Register the async `render_ui` tool and the late-resolving image route.
 *
 * @param ctx - Cordis context.
 * @param config - `maxImages`, `width`, `engine` (see README).
 */
export function apply(ctx, config) {
  const settings = config ?? {}

  /* Without this a fresh session has no idea the route exists and falls back
     to downloading files with image_hunt. */
  ctx.systemPrompt.section({
    name: 'async-ui:images',
    // Place image-specific rules after both GenUI and the user-personalization section (order 4000).
    order: Math.max(ctx.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT') + 1, 5000),
    text: SECTION_TEXT,
  })

  if (settings.imageReminder !== false) {
    ctx.on('agent/pre-step', async (_event, next) => {
      const decision = await next()
      if (decision === undefined || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
      /* `messages` are the NEW messages this step appends to the session, and
         the agent ends a turn when a step has nothing new to append. Riding
         along with a real user message — once per user turn — keeps that
         intact; a reminder on every step would keep every turn running. */
      if (!decision.messages.some(message => message?.source?.kind === 'user')) return decision
      return { ...decision, messages: [...decision.messages, reminderMessage()] }
    })

    /* A tool result always has a next step, so a reminder riding on one never
       changes when a turn ends. These two results are read right before the
       answer is written: the GenUI skill text (the "fewer components" rules)
       and the fence check. */
    const lastValidationReminder = new WeakMap()
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      const downstream = await next()
      let wanted = false
      if (exec?.name === 'skill') {
        let args = exec.arguments
        if (typeof args === 'string') {
          try { args = JSON.parse(args) } catch { args = undefined }
        }
        wanted = args?.name === 'genui'
      } else if (exec?.name === 'validate_dsh_ui') {
        const agent = exec.agent
        const last = agent !== null && typeof agent === 'object' ? lastValidationReminder.get(agent) : undefined
        wanted = last === undefined || Date.now() - last > VALIDATION_REMINDER_GAP_MS
        if (wanted && agent !== null && typeof agent === 'object') lastValidationReminder.set(agent, Date.now())
      }
      if (!wanted || downstream === undefined || downstream === null) return downstream
      return { ...downstream, additionalContexts: [reminderMessage(), ...(downstream.additionalContexts ?? [])] }
    })
  }

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = typeof webCtx.reflect?.get === 'function'
      ? webCtx.reflect.get('webServer')
      : webCtx.webServer
    if (webServer === undefined || typeof webServer.register !== 'function') return
    try {
      /* Old messages in the conversation still point at the first route name;
         keep it alive so历史里的图 don't turn into broken images. */
      for (const legacy of ['/async-ui-img']) {
        webCtx.effect(
          () => webServer.register({
            kind: 'prefix',
            path: legacy,
            handler: (req, res) => { res.writeHead(302, { location: `/async-img${(req.url ?? '').slice(req.url.indexOf('?') === -1 ? req.url.length : req.url.indexOf('?'))}` }); res.end() },
          }, 'dsh-async-ui: legacy route'),
        )
      }
      webCtx.effect(
        () => webServer.register({
          kind: 'prefix',
          path: STYLE_ROUTE,
          handler: (req, res) => {
            readFile(STYLE_FILE).then((buffer) => {
              res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'public, max-age=3600',
                'x-async-ui-style': 'openfreemap-liberty',
              })
              res.end(buffer)
            }).catch((error) => {
              try {
                res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
                res.end(String((error && error.message) || error))
              } catch {}
            })
          },
        }),
        'dsh-async-ui: map style route',
      )
      webCtx.effect(
        () => webServer.register({
          kind: 'prefix',
          path: META_ROUTE,
          handler: (req, res) => {
            try {
              serveMeta(req, res)
            } catch (error) {
              try { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end(String(error)) } catch {}
            }
          },
        }),
        'dsh-async-ui: image source route',
      )
      webCtx.effect(
        () => webServer.register({
          kind: 'prefix',
          path: ROUTE,
          handler: (req, res) => {
            Promise.resolve()
              .then(() => serveAsyncImage(req, res))
              .catch((error) => {
                try {
                  res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
                  res.end(String((error && error.stack) || error))
                } catch {}
              })
          },
        }),
        'dsh-async-ui: async image route',
      )
      routeReady = true
    } catch {
      routeReady = false
    }
  })

}
