/**
 * Client 半装配测试：在 node:vm 里加载 client.js（stub window/react），
 * 验证页类型注册、slot 挂载、file 地址 canOpen/title、500ms 重试兜底，
 * 以及编辑正文根节点上的跨插件 data 属性（用 fake React 返回元素树，不跑真实渲染）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const CLIENT_SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 在 vm 里执行 client.js，返回 { exported, scheduled }。 */
function bootClient() {
  const loaded = {}
  const scheduled = []
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (definition) => { loaded.definition = definition } },
      setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length },
      addEventListener: () => {},
      removeEventListener: () => {},
      confirm: () => true,
    },
    console,
    URLSearchParams,
    fetch: () => Promise.reject(new Error('测试环境不联网')),
  }
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_SOURCE, sandbox)
  assert.ok(loaded.definition, 'client.js 应通过 __ModuleLoader__ 注册模块')
  assert.equal(loaded.definition.id, 'dsh-workbench-sheets')

  const react = {
    // 只记录元素树，不做真实渲染；组件函数由测试直接调用以取首帧 props
    createElement: (type, props) => ({ type, props: props || {} }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
  }
  const exported = loaded.definition.factory((name) => {
    if (name === 'react') return react
    throw new Error('client.js 只允许 require("react")，实际请求了：' + name)
  })
  return { exported, scheduled, sandbox, react }
}

/** 建假 ctx（sidebarRightTabs + slots 已就绪）。 */
function makeReadyContext() {
  const captured = {}
  const ctx = {
    get(name) {
      if (name === 'sidebarRightTabs') {
        return { register: (definition) => { captured.tabs = definition; return () => {} } }
      }
      if (name === 'slots') {
        return {
          inject: (name, callback) => {
            captured.slotName = name
            captured.body = callback()
            return () => {}
          },
          register: (spec, component) => {
            captured.bodySpec = spec
            captured.bodyComponent = component
            return () => {}
          },
        }
      }
      return undefined
    },
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  return { ctx, captured }
}

test('注册页类型与正文 slot：id/kind/patterns/priority/canOpen/title 符合契约', () => {
  const { exported } = bootClient()
  assert.equal(typeof exported.apply, 'function')
  const { ctx, captured } = makeReadyContext()
  exported.apply(ctx)

  assert.equal(captured.tabs.id, 'dsh-workbench-sheets')
  assert.equal(captured.tabs.kind, 'dshWorkbenchSheets')
  // vm 沙盒里的数组与测试 realm 原型不同，先复制回当前 realm 再比较
  assert.deepEqual(Array.from(captured.tabs.patterns), ['dsh-resource://file/**'])
  assert.equal(captured.tabs.priority, 'extension')
  assert.equal(typeof captured.tabs.canOpen, 'function')
  assert.equal(typeof captured.tabs.title, 'function')

  assert.equal(captured.slotName, 'sidebar.right.pane.tab')
  assert.equal(captured.bodySpec.key, 'dsh-workbench-sheets')
  assert.equal(typeof captured.bodyComponent, 'function')
})

test('canOpen：只认 csv/tsv/xlsx（session 域与 absolute 域都支持）', () => {
  const { exported } = bootClient()
  const { ctx, captured } = makeReadyContext()
  exported.apply(ctx)
  const canOpen = captured.tabs.canOpen

  assert.equal(canOpen('dsh-resource://file/session/s1/data.csv'), true)
  assert.equal(canOpen('dsh-resource://file/session/s1/dir/sub/data.TSV'), true)
  assert.equal(canOpen('dsh-resource://file/session/s1/book.xlsx'), true)
  assert.equal(canOpen('dsh-resource://file/absolute/Users/u/My%20Book.xlsx'), true)
  assert.equal(canOpen('dsh-resource://file/absolute/Users/u/notes.md'), false)
  assert.equal(canOpen('dsh-resource://file/session/s1/readme'), false)
  assert.equal(canOpen('not-a-file-address'), false)
  assert.equal(canOpen('dsh-resource://file/session/s1/%E0%A4%A.csv'), false) // 非法百分号编码
})

test('title：取解码后的 basename', () => {
  const { exported } = bootClient()
  const { ctx, captured } = makeReadyContext()
  exported.apply(ctx)
  const title = captured.tabs.title
  assert.equal(title('dsh-resource://file/session/s1/sub/%E8%A1%A8%E6%A0%BC.csv'), '表格.csv')
  assert.equal(title('dsh-resource://file/absolute/Users/u/My%20Book.xlsx'), 'My Book.xlsx')
  assert.equal(title('bogus'), 'bogus')
})

test('500ms 重试兜底：服务晚到时第二次尝试完成注册', () => {
  const { exported, scheduled } = bootClient()
  let getCalls = 0
  const captured = {}
  const ctx = {
    get(name) {
      getCalls += 1
      if (getCalls <= 2) return undefined // 第一次 install：tabs/slots 都还没就绪
      if (name === 'sidebarRightTabs') return { register: (definition) => { captured.tabs = definition; return () => {} } }
      if (name === 'slots') {
        return {
          inject: (slotName, callback) => { captured.slotName = slotName; callback(); return () => {} },
          register: () => () => {},
        }
      }
      return undefined
    },
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  exported.apply(ctx)
  assert.equal(scheduled.length, 1, '服务缺失时应安排一次重试')
  assert.equal(scheduled[0].delay, 500)
  assert.equal(captured.tabs, undefined)
  scheduled[0].callback()
  assert.ok(captured.tabs, '重试时服务就绪应完成注册')
  assert.equal(captured.tabs.id, 'dsh-workbench-sheets')
})

test('编辑正文根节点带 dsh-editor-context 所需的 data 属性（address/path/kind）', () => {
  const { exported } = bootClient()
  const { ctx, captured } = makeReadyContext()
  exported.apply(ctx)
  const SheetTab = captured.bodyComponent
  assert.equal(typeof SheetTab, 'function')

  /** 调页签组件拿首帧最外层元素；三种正文根（加载/错误/编辑器）共用 rootProps。 */
  function firstFrame(address) {
    const tabElement = SheetTab({ useTabInfo: () => ({ tab: { contentId: address } }) })
    assert.equal(tabElement.type.name, 'SheetEditor')
    return tabElement.type(tabElement.props)
  }

  // session 域：address 保留原始编码，path 解码为相对路径，kind 为 csv
  const sessionRoot = firstFrame('dsh-resource://file/session/s1/sub/a%20b.csv')
  assert.equal(sessionRoot.props['data-workbench-sheets-address'], 'dsh-resource://file/session/s1/sub/a%20b.csv')
  assert.equal(sessionRoot.props['data-workbench-sheets-path'], 'sub/a b.csv')
  assert.equal(sessionRoot.props['data-workbench-sheets-kind'], 'csv')

  // absolute 域：path 为绝对路径，kind 为 xlsx
  const absoluteRoot = firstFrame('dsh-resource://file/absolute/Users/u/My%20Book.xlsx')
  assert.equal(absoluteRoot.props['data-workbench-sheets-path'], '/Users/u/My Book.xlsx')
  assert.equal(absoluteRoot.props['data-workbench-sheets-kind'], 'xlsx')

  // .tsv 后缀
  const tsvRoot = firstFrame('dsh-resource://file/session/s1/data.tsv')
  assert.equal(tsvRoot.props['data-workbench-sheets-kind'], 'tsv')

  // 地址缺失：三个属性均为空串，错误态根同样带齐属性
  const missingRoot = firstFrame('')
  assert.equal(missingRoot.props['data-workbench-sheets-address'], '')
  assert.equal(missingRoot.props['data-workbench-sheets-path'], '')
  assert.equal(missingRoot.props['data-workbench-sheets-kind'], '')
})
