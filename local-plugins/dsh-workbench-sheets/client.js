/**
 * dsh-workbench-sheets — Client half。
 *
 * 在官方右侧 Sidebar（Cursor 视图的中列工作台）注册 extension 档页类型：工作区文件地址
 * `dsh-resource://file/**` 且后缀为 csv/tsv/xlsx 时由本插件接管，正文是可编辑表格。
 * 文件读写走本插件 Host 半的同源本地路由（/workbench-sheets/file、/save）。
 *
 * 本文件是 plain-JS 客户端插件（无构建），只可 require loader 提供的模块（react 等），
 * 不要 import 本地 npm 依赖。
 *
 * 交互约定（与 DEV-NOTES 契约一致）：
 *  - 单击单元格进入编辑（input），Enter 提交并下移、Tab 提交并右移、Esc 取消、失焦提交；
 *  - Ctrl/Cmd+S 保存（只在正文根节点 onKeyDown 上监听，不占用 window 全局键）；
 *  - XLSX 多 sheet 页签；只提交 diff（edits），未改的 cell 不提交；
 *  - CSV/TSV 单表，可「+ 添加行 / + 添加列」，保存时整表按原格式回写。
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbench-sheets',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    // ---------- 常量 ----------
    const TAB_ID = 'dsh-workbench-sheets'
    const TAB_KIND = 'dshWorkbenchSheets'
    const FILE_PREFIX = 'dsh-resource://file/'
    const EXT_SET = new Set(['csv', 'tsv', 'xlsx'])
    const ROUTE_FILE = '/workbench-sheets/file'
    const ROUTE_SAVE = '/workbench-sheets/save'
    /** 渲染上限：大表只渲染前 N 行 × M 列并提示（不虚拟化，先保证简单可靠）。 */
    const MAX_RENDER_ROWS = 2000
    const MAX_RENDER_COLS = 200
    /** 二次预算：行 × 列超过该值再砍行数，避免一次插入几十万个 DOM 节点。 */
    const MAX_RENDER_CELLS = 60000

    const COLORS = {
      base: 'var(--dsw-alias-bg-base)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      border: 'var(--dsw-alias-border-l1)',
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      danger: '#d9534f',
      dirty: 'rgba(64, 120, 255, 0.14)',
    }

    // ---------- 官方 file 资源地址解析（与 vscode-mode / dsh-util-workspace-path 同语法） ----------

    function decodeSegment(raw) {
      if (raw === undefined) return null
      try { return decodeURIComponent(raw) } catch { return null }
    }

    /** 官方 file 资源地址 → { path, sessionId? }。绝对域无 sessionId。 */
    function parseFileAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(FILE_PREFIX)) return null
      const [scope, ...tail] = address.slice(FILE_PREFIX.length).split('/')
      const kind = decodeSegment(scope)
      if (kind === 'session') {
        const sessionId = decodeSegment(tail[0])
        const segments = tail.slice(1).map(decodeSegment)
        if (!sessionId || segments.length === 0 || segments.some((segment) => segment === null)) return null
        const path = segments.join('/')
        return path ? { path, sessionId } : null
      }
      if (kind === 'absolute') {
        const unc = tail[0] === '' && tail.length > 1
        const segments = (unc ? tail.slice(1) : tail).map(decodeSegment)
        if (segments.length === 0 || segments[0] === '' || segments.some((segment) => segment === null)) return null
        if (unc) return { path: '//' + segments.join('/') }
        if (/^[A-Za-z]:$/.test(segments[0])) return { path: segments.join('/') }
        return { path: '/' + segments.join('/') }
      }
      return null
    }

    function suffixOf(path) {
      const base = String(path || '').replace(/\\/g, '/').split('/').pop() || ''
      const dot = base.lastIndexOf('.')
      return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
    }

    function canOpen(address) {
      const file = parseFileAddress(address)
      return file !== null && EXT_SET.has(suffixOf(file.path))
    }

    function titleOf(address) {
      const file = parseFileAddress(address)
      const source = file ? file.path : String(address || '')
      const normalized = source.replace(/\\/g, '/')
      return normalized.slice(normalized.lastIndexOf('/') + 1) || source
    }

    // ---------- 通用工具 ----------

    function basename(path) {
      const normalized = String(path || '').replace(/\\/g, '/')
      return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized
    }

    /** 0 基列号 → A/B/.../AA 的表格列名。 */
    function columnLabel(index) {
      let value = index + 1
      let label = ''
      while (value > 0) {
        const remainder = (value - 1) % 26
        label = String.fromCharCode(65 + remainder) + label
        value = Math.floor((value - 1) / 26)
      }
      return label
    }

    function maxColumns(rows) {
      let max = 0
      for (const row of rows || []) {
        if (Array.isArray(row) && row.length > max) max = row.length
      }
      return max
    }

    /** 某 sheet（CSV 传 null）的行数组。 */
    function rowsFor(data, sheetName) {
      if (!data) return []
      if (data.kind === 'xlsx') {
        const sheet = (data.sheets || []).find((item) => item.name === sheetName)
        return sheet && Array.isArray(sheet.rows) ? sheet.rows : []
      }
      return Array.isArray(data.rows) ? data.rows : []
    }

    /** XLSX cell → 编辑框初始文本（公式显示 `=...` 原文，其余显示值）。 */
    function cellRaw(cell) {
      if (cell === null || cell === undefined) return ''
      if (typeof cell === 'object') {
        if (typeof cell.f === 'string' && cell.f !== '') return '=' + cell.f
        return cell.v === null || cell.v === undefined ? '' : String(cell.v)
      }
      return String(cell)
    }

    /** XLSX cell → 只读展示文本（公式显示结果；无结果时退回公式原文）。 */
    function cellText(cell) {
      if (cell === null || cell === undefined) return ''
      if (typeof cell === 'object') {
        if (cell.v === null || cell.v === undefined) return typeof cell.f === 'string' && cell.f ? '=' + cell.f : ''
        return String(cell.v)
      }
      return String(cell)
    }

    /** 建立 XLSX 原始值查找表（key: sheet!row:col，0 基），用于判定「改回原值就不再是 diff」。 */
    function buildOriginalLookup(sheets) {
      const lookup = {}
      for (const sheet of sheets || []) {
        const rows = sheet && Array.isArray(sheet.rows) ? sheet.rows : []
        for (let row = 0; row < rows.length; row++) {
          const line = rows[row] || []
          for (let col = 0; col < line.length; col++) {
            const cell = line[col]
            if (cell && (cell.f || (cell.v !== null && cell.v !== undefined))) {
              lookup[sheet.name + '!' + row + ':' + col] = cellRaw(cell)
            }
          }
        }
      }
      return lookup
    }

    function countSheetEdits(edits, sheetName) {
      let count = 0
      const prefix = sheetName + '!'
      for (const key of Object.keys(edits || {})) {
        if (key.startsWith(prefix)) count += 1
      }
      return count
    }

    function hasRiskFeatures(features) {
      if (!features) return false
      return Boolean(features.charts || features.images || features.pivot || features.conditionalFormatting)
    }

    function formatSaveError(error) {
      if (!error) return '保存失败'
      if (error.status === 409 || error.code === 'conflict') return '文件已被外部修改，请重新加载后再保存。'
      const message = error.message || String(error)
      return message.indexOf('保存失败') === 0 ? message : '保存失败：' + message
    }

    // ---------- 同源请求 ----------

    /**
     * 相对路由 → 同源绝对 URL。
     * 用 document.baseURI 的目录部分作 root（与 dsh-editor-context 已实测可用的做法一致），
     * 这样即使 GUI 不是挂在站点根路径也能命中 Host 路由。
     */
    function appUrlOf(path) {
      try {
        const root = new URL('.', document.baseURI)
        return new URL(String(path).replace(/^\/+/, ''), root).href
      } catch (error) {
        return path
      }
    }

    async function requestJson(url, options) {
      let response
      try {
        response = await fetch(url, Object.assign({ credentials: 'same-origin' }, options))
      } catch (cause) {
        throw new Error('无法连接本地服务：' + String((cause && cause.message) || cause))
      }
      let payload = null
      try { payload = await response.json() } catch { payload = null }
      if (response.ok && payload && payload.ok === true) return payload
      const message = payload && typeof payload.error === 'string' && payload.error
        ? payload.error
        : '请求失败（HTTP ' + response.status + '）'
      const error = new Error(message)
      error.status = response.status
      if (payload && payload.code) error.code = payload.code
      throw error
    }

    // ---------- 样式 ----------

    const rootStyle = {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      outline: 'none',
      background: COLORS.base,
      color: COLORS.primary,
      fontFamily: 'var(--dsw-font-family, system-ui)',
      fontSize: 12.5,
    }
    const centerStyle = {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      padding: 24,
      color: COLORS.secondary,
      textAlign: 'center',
      lineHeight: 1.7,
    }
    const toolbarStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 8px',
      borderBottom: '1px solid ' + COLORS.border,
      background: COLORS.layer,
      flexShrink: 0,
      minHeight: 34,
    }
    const badgeStyle = {
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 0.5,
      padding: '1px 5px',
      borderRadius: 4,
      border: '1px solid ' + COLORS.border,
      color: COLORS.secondary,
      flexShrink: 0,
    }
    const statusBarStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '2px 8px',
      fontSize: 11,
      color: COLORS.secondary,
      borderBottom: '1px solid ' + COLORS.border,
      flexShrink: 0,
      minHeight: 20,
    }
    const tableWrapStyle = { flex: 1, minHeight: 0, overflow: 'auto', background: COLORS.base }
    const tableStyle = { borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: '100%' }
    const headerCellStyle = {
      position: 'sticky',
      top: 0,
      zIndex: 3,
      background: COLORS.layer,
      borderBottom: '1px solid ' + COLORS.border,
      borderRight: '1px solid ' + COLORS.border,
      padding: '3px 6px',
      textAlign: 'left',
      fontSize: 11,
      fontWeight: 600,
      color: COLORS.secondary,
      whiteSpace: 'nowrap',
    }
    const cornerStyle = Object.assign({}, headerCellStyle, { left: 0, zIndex: 4 })
    const rowNumberStyle = {
      position: 'sticky',
      left: 0,
      zIndex: 2,
      background: COLORS.layer,
      borderBottom: '1px solid ' + COLORS.border,
      borderRight: '1px solid ' + COLORS.border,
      padding: '3px 6px',
      textAlign: 'right',
      fontSize: 11,
      color: COLORS.secondary,
      whiteSpace: 'nowrap',
    }
    const cellStyle = {
      padding: '3px 6px',
      fontSize: 12,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      color: COLORS.primary,
      minHeight: 18,
    }
    const editorInputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      border: '2px solid ' + COLORS.brand,
      outline: 'none',
      borderRadius: 2,
      background: COLORS.base,
      color: COLORS.primary,
      font: 'inherit',
      fontSize: 12,
      padding: '1px 4px',
      margin: 0,
    }
    const noticeStyle = {
      padding: '4px 8px',
      fontSize: 11,
      color: COLORS.secondary,
      background: COLORS.layer,
      borderBottom: '1px solid ' + COLORS.border,
      flexShrink: 0,
    }
    const footerStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 8px',
      borderTop: '1px solid ' + COLORS.border,
      background: COLORS.layer,
      flexShrink: 0,
      fontSize: 11,
      color: COLORS.secondary,
    }

    /** 按钮样式（主题变量取色；primary 用于保存按钮）。 */
    function buttonStyle(options) {
      const opts = options || {}
      const disabled = Boolean(opts.disabled)
      const primary = Boolean(opts.primary)
      return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid ' + (primary ? 'transparent' : COLORS.border),
        background: primary ? COLORS.brand : COLORS.layer,
        color: primary ? '#fff' : COLORS.primary,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        font: 'inherit',
        fontSize: 12,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
      }
    }

    // ---------- 单元格编辑框 ----------

    function CellEditor(props) {
      const [value, setValue] = useState(props.initialValue)
      const inputRef = useRef(null)
      const doneRef = useRef(false)

      useEffect(() => {
        const element = inputRef.current
        if (!element) return
        element.focus({ preventScroll: true })
        try { element.select() } catch { /* 某些浏览器不支持 select */ }
      }, [])

      function finish(callback) {
        if (doneRef.current) return
        doneRef.current = true
        callback.apply(null, Array.prototype.slice.call(arguments, 1))
      }

      return h('input', {
        ref: inputRef,
        value: value,
        spellCheck: false,
        onChange: (event) => setValue(event.target.value),
        onBlur: () => finish(props.onCommit, value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            finish(props.onCommit, value, 'down')
          } else if (event.key === 'Tab') {
            event.preventDefault()
            event.stopPropagation()
            finish(props.onCommit, value, 'right')
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            finish(props.onCancel)
          } else if ((event.metaKey || event.ctrlKey) && (event.key === 's' || event.key === 'S')) {
            // 先提交当前编辑，再由根节点的 Ctrl/Cmd+S 处理器统一保存
            finish(props.onCommit, value)
          }
        },
        style: editorInputStyle,
      })
    }

    // ---------- 表格编辑器 ----------

    function SheetEditor(props) {
      const filePath = props.filePath
      const sessionId = props.sessionId
      const address = props.address
      /** csv/tsv/xlsx（供 dsh-editor-context 等 DOM 观察方读取；解析失败为空串）。 */
      const fileKind = props.kind || ''

      const [status, setStatus] = useState(filePath ? 'loading' : 'error')
      const [error, setError] = useState(filePath ? null : '无法解析文件地址：' + (address || '(空)'))
      const [data, setDataState] = useState(null)
      const [activeSheetIndex, setActiveSheetIndex] = useState(0)
      const [editing, setEditing] = useState(null)
      const [edits, setEditsState] = useState({})
      const [csvDirty, setCsvDirtyState] = useState(false)
      const [csvDirtyCells, setCsvDirtyCellsState] = useState({})
      const [saving, setSaving] = useState(false)
      const [saveError, setSaveError] = useState(null)
      const [savedAt, setSavedAt] = useState(null)

      const dataRef = useRef(null)
      const editsRef = useRef({})
      const csvDirtyRef = useRef(false)
      const csvDirtyCellsRef = useRef({})
      const originalRef = useRef({})
      const dirtyRef = useRef(false)
      const savingRef = useRef(false)
      const statusRef = useRef(status)
      const loadSeqRef = useRef(0)
      const rootRef = useRef(null)

      function setData(next) { dataRef.current = next; setDataState(next) }
      function setEdits(next) { editsRef.current = next; setEditsState(next) }
      function setCsvDirty(next) { csvDirtyRef.current = next; setCsvDirtyState(next) }
      function setCsvDirtyCells(next) { csvDirtyCellsRef.current = next; setCsvDirtyCellsState(next) }

      useEffect(() => { statusRef.current = status }, [status])

      const isXlsx = Boolean(data && data.kind === 'xlsx')
      const dirty = isXlsx ? Object.keys(edits).length > 0 : csvDirty
      useEffect(() => { dirtyRef.current = dirty }, [dirty])

      // ---------- 载入 ----------

      const load = useCallback(async () => {
        if (!filePath) {
          setStatus('error')
          setError('无法解析文件地址：' + (address || '(空)'))
          return
        }
        const sequence = ++loadSeqRef.current
        setStatus('loading')
        setError(null)
        setSaveError(null)
        setSavedAt(null)
        setEditing(null)
        setCsvDirty(false)
        setCsvDirtyCells({})
        setEdits({})
        const params = new URLSearchParams()
        if (sessionId) params.set('sessionId', sessionId)
        params.set('path', filePath)
        try {
          const loaded = await requestJson(appUrlOf(ROUTE_FILE) + '?' + params.toString())
          if (sequence !== loadSeqRef.current) return
          if (loaded.kind === 'xlsx') {
            originalRef.current = buildOriginalLookup(loaded.sheets || [])
            setActiveSheetIndex(0)
          } else {
            if (!Array.isArray(loaded.rows) || loaded.rows.length === 0) loaded.rows = [['']]
            originalRef.current = {}
          }
          setData(loaded)
          setStatus('ready')
        } catch (loadError) {
          if (sequence !== loadSeqRef.current) return
          setError(loadError.message || String(loadError))
          setStatus('error')
        }
      }, [filePath, sessionId, address])

      useEffect(() => { load() }, [load])
      useEffect(() => () => { loadSeqRef.current += 1 }, [])

      // 有未保存修改时离开页面要确认
      useEffect(() => {
        const onBeforeUnload = (event) => {
          if (!dirtyRef.current) return
          event.preventDefault()
          event.returnValue = '有未保存的修改'
        }
        window.addEventListener('beforeunload', onBeforeUnload)
        return () => window.removeEventListener('beforeunload', onBeforeUnload)
      }, [])

      // ---------- 保存 ----------

      const saveNow = useCallback(async () => {
        const current = dataRef.current
        if (!current || statusRef.current !== 'ready' || savingRef.current) return
        const currentIsXlsx = current.kind === 'xlsx'
        const editList = currentIsXlsx ? Object.keys(editsRef.current).map((key) => editsRef.current[key]) : null
        const isDirty = currentIsXlsx ? editList.length > 0 : csvDirtyRef.current
        if (!isDirty) return
        if (currentIsXlsx && hasRiskFeatures(current.features)) {
          const lines = Array.isArray(current.warnings) && current.warnings.length
            ? current.warnings
            : ['保存后可能丢失部分工作簿结构']
          if (!window.confirm(lines.join('\n') + '\n\n仍要保存并写回原文件吗？')) return
        }
        savingRef.current = true
        setSaving(true)
        setSaveError(null)
        try {
          const body = { kind: current.kind, path: filePath, mtimeMs: current.mtimeMs, size: current.size }
          if (sessionId) body.sessionId = sessionId
          if (currentIsXlsx) body.edits = editList
          else body.rows = current.rows
          const result = await requestJson(appUrlOf(ROUTE_SAVE), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const latest = dataRef.current
          setData({
            mtimeMs: result.mtimeMs,
            size: result.size,
            warnings: Array.isArray(result.warnings) ? result.warnings : latest.warnings,
            kind: latest.kind,
            rows: latest.rows,
            sheets: latest.sheets,
            features: latest.features,
            delimiter: latest.delimiter,
            encoding: latest.encoding,
            hasBom: latest.hasBom,
            eol: latest.eol,
          })
          if (currentIsXlsx) {
            originalRef.current = buildOriginalLookup(dataRef.current.sheets || [])
            setEdits({})
          } else {
            setCsvDirty(false)
            setCsvDirtyCells({})
          }
          setSavedAt(Date.now())
        } catch (saveFailure) {
          setSaveError(formatSaveError(saveFailure))
        } finally {
          savingRef.current = false
          setSaving(false)
        }
      }, [filePath, sessionId])

      function reloadNow() {
        if (dirtyRef.current && !window.confirm('有未保存的修改，重新加载会丢弃这些修改。继续？')) return
        load()
      }

      // ---------- 编辑 ----------

      function beginEdit(row, col) {
        const line = rows[row] || []
        const cell = isXlsx ? line[col] : (line[col] === undefined ? '' : line[col])
        setEditing({ row: row, col: col, value: isXlsx ? cellRaw(cell) : String(cell === null || cell === undefined ? '' : cell) })
      }

      function cancelEditing() { setEditing(null) }

      function updateCsvCell(row, col, rawValue) {
        const current = dataRef.current
        if (!current) return
        const rows = current.rows.map((line) => line.slice())
        while (rows.length <= row) rows.push([])
        while (rows[row].length <= col) rows[row].push('')
        rows[row][col] = rawValue
        setData(Object.assign({}, current, { rows: rows }))
        setCsvDirty(true)
        setCsvDirtyCells(Object.assign({}, csvDirtyCellsRef.current, { [row + ':' + col]: true }))
      }

      function updateXlsxCell(sheetName, row, col, rawValue) {
        const current = dataRef.current
        if (!current) return
        const text = String(rawValue)
        const isFormula = text.length > 1 && text.charAt(0) === '='
        const sheets = current.sheets.map((sheet) => {
          if (sheet.name !== sheetName) return sheet
          const rows = sheet.rows.map((line) => line.slice())
          while (rows.length <= row) rows.push([])
          while (rows[row].length <= col) rows[row].push({ v: null })
          if (text === '') rows[row][col] = { v: null }
          else if (isFormula) rows[row][col] = { v: undefined, f: text.slice(1) }
          else rows[row][col] = { v: text }
          return Object.assign({}, sheet, { rows: rows })
        })
        const key = sheetName + '!' + row + ':' + col
        const original = originalRef.current[key]
        const unchanged = (original === undefined && text === '') || (original !== undefined && original === text)
        const nextEdits = Object.assign({}, editsRef.current)
        if (unchanged) {
          delete nextEdits[key]
        } else {
          const edit = { sheet: sheetName, row: row + 1, col: col + 1 }
          if (text === '') edit.blank = true
          else if (isFormula) edit.f = text.slice(1)
          else edit.v = text
          nextEdits[key] = edit
        }
        setData(Object.assign({}, current, { sheets: sheets }))
        setEdits(nextEdits)
      }

      function moveEditing(from, direction) {
        const current = dataRef.current
        if (!current) return
        const sheetName = current.kind === 'xlsx' ? ((current.sheets[activeSheetIndex] || {}).name || '') : ''
        const rows = rowsFor(current, sheetName)
        const row = from.row
        const col = from.col
        if (direction === 'down') {
          if (row + 1 >= rows.length) return
          const line = rows[row + 1] || []
          const cell = current.kind === 'xlsx' ? line[col] : (line[col] === undefined ? '' : line[col])
          setEditing({ row: row + 1, col: col, value: current.kind === 'xlsx' ? cellRaw(cell) : String(cell === null || cell === undefined ? '' : cell) })
        } else if (direction === 'right') {
          const width = maxColumns(rows)
          if (col + 1 >= width) return
          const line = rows[row] || []
          const cell = current.kind === 'xlsx' ? line[col + 1] : (line[col + 1] === undefined ? '' : line[col + 1])
          setEditing({ row: row, col: col + 1, value: current.kind === 'xlsx' ? cellRaw(cell) : String(cell === null || cell === undefined ? '' : cell) })
        }
      }

      function commitEditing(rawValue, direction) {
        const currentEditing = editing
        if (!currentEditing) return
        const current = dataRef.current
        setEditing(null)
        if (!current) return
        if (current.kind === 'xlsx') {
          const sheet = (current.sheets || [])[activeSheetIndex]
          if (!sheet) return
          updateXlsxCell(sheet.name, currentEditing.row, currentEditing.col, rawValue)
        } else {
          updateCsvCell(currentEditing.row, currentEditing.col, rawValue)
        }
        if (direction) moveEditing(currentEditing, direction)
      }

      function addRow() {
        const current = dataRef.current
        if (!current || current.kind === 'xlsx') return
        const width = Math.max(1, maxColumns(current.rows))
        const rows = current.rows.map((line) => line.slice())
        rows.push(new Array(width).fill(''))
        setData(Object.assign({}, current, { rows: rows }))
        setCsvDirty(true)
      }

      function addColumn() {
        const current = dataRef.current
        if (!current || current.kind === 'xlsx') return
        const rows = current.rows.length ? current.rows.map((line) => line.concat([''])) : [['']]
        setData(Object.assign({}, current, { rows: rows }))
        setCsvDirty(true)
      }

      // ---------- 根节点事件（键位只挂这里，不占 window） ----------

      function onRootKeyDown(event) {
        if (event.defaultPrevented) return
        if ((event.metaKey || event.ctrlKey) && (event.key === 's' || event.key === 'S')) {
          event.preventDefault()
          event.stopPropagation()
          saveNow()
        }
      }

      function onRootMouseDown(event) {
        const target = event.target
        if (target && typeof target.closest === 'function' && (target.closest('input') || target.closest('button'))) return
        if (rootRef.current && document.activeElement !== rootRef.current) {
          try { rootRef.current.focus({ preventScroll: true }) } catch { /* 聚焦失败不影响点击 */ }
        }
      }

      // ---------- 渲染 ----------

      const activeSheet = isXlsx ? ((data.sheets || [])[activeSheetIndex] || null) : null
      const activeSheetName = activeSheet ? activeSheet.name : ''
      const rows = data ? rowsFor(data, activeSheetName) : []
      const totalRows = rows.length
      const totalCols = maxColumns(rows)
      const renderCols = Math.min(Math.max(totalCols, 1), MAX_RENDER_COLS)
      const renderedRowBudget = Math.max(1, Math.floor(MAX_RENDER_CELLS / Math.max(1, renderCols)))
      const shownRows = Math.min(Math.max(totalRows, 1), MAX_RENDER_ROWS, renderedRowBudget)
      const hiddenRows = totalRows > shownRows
      const hiddenCols = totalCols > MAX_RENDER_COLS

      const rootProps = {
        ref: rootRef,
        tabIndex: 0,
        onKeyDown: onRootKeyDown,
        onMouseDown: onRootMouseDown,
        style: rootStyle,
        'data-wb-sheets': '1',
        // 跨插件观测契约（dsh-editor-context 读取活动 pane 内的这些属性判断「用户在看哪个文件」）；
        // 加载/错误/编辑器三种正文根共用 rootProps，保证可见的那个根始终带齐属性。
        'data-workbench-sheets-address': address || '',
        'data-workbench-sheets-path': filePath || '',
        'data-workbench-sheets-kind': fileKind,
      }

      if (status === 'loading') {
        return h('div', rootProps, h('div', { style: centerStyle }, '正在读取文件…'))
      }
      if (status === 'error') {
        return h('div', rootProps, h('div', { style: centerStyle }, [
          h('div', { key: 'message', style: { maxWidth: 520, color: COLORS.danger } }, error || '加载失败'),
          h('button', { key: 'retry', type: 'button', onClick: load, style: buttonStyle({}) }, '重试'),
        ]))
      }

      function isCellDirty(row, col) {
        if (isXlsx) return Boolean(edits[activeSheetName + '!' + row + ':' + col])
        return Boolean(csvDirtyCells[row + ':' + col])
      }

      function renderGrid() {
        const headerCells = [h('th', { key: 'corner', style: cornerStyle }, '')]
        for (let col = 0; col < renderCols; col++) {
          headerCells.push(h('th', { key: 'h' + col, style: headerCellStyle }, columnLabel(col)))
        }
        const bodyRows = []
        for (let row = 0; row < shownRows; row++) {
          const line = rows[row] || []
          const cells = [h('td', { key: 'rn' + row, style: rowNumberStyle }, String(row + 1))]
          for (let col = 0; col < renderCols; col++) {
            const cell = isXlsx ? line[col] : (line[col] === undefined ? '' : line[col])
            const editingHere = Boolean(editing && editing.row === row && editing.col === col)
            cells.push(h('td', {
              key: 'c' + row + ':' + col,
              style: {
                padding: 0,
                borderRight: '1px solid ' + COLORS.border,
                borderBottom: '1px solid ' + COLORS.border,
                background: isCellDirty(row, col) ? COLORS.dirty : 'transparent',
                verticalAlign: 'top',
              },
              onClick: editingHere ? undefined : () => beginEdit(row, col),
            }, editingHere
              ? h(CellEditor, {
                key: 'editor',
                initialValue: editing.value,
                onCommit: commitEditing,
                onCancel: cancelEditing,
              })
              : h('div', { style: cellStyle }, isXlsx ? cellText(cell) : String(cell === null || cell === undefined ? '' : cell))))
          }
          bodyRows.push(h('tr', { key: 'r' + row, style: { height: 22 } }, cells))
        }
        const colgroup = [h('col', { key: 'rn', style: { width: 48 } })]
        for (let col = 0; col < renderCols; col++) colgroup.push(h('col', { key: 'c' + col, style: { width: 120 } }))
        return h('div', { key: 'table-wrap', style: tableWrapStyle }, h('table', { style: tableStyle }, [
          h('colgroup', { key: 'colgroup' }, colgroup),
          h('thead', { key: 'head' }, h('tr', null, headerCells)),
          h('tbody', { key: 'body' }, bodyRows),
        ]))
      }

      const toolbar = h('div', { key: 'toolbar', style: toolbarStyle }, [
        h('span', {
          key: 'name',
          title: filePath,
          style: {
            fontWeight: 600,
            color: COLORS.primary,
            fontSize: 13,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: '50%',
          },
        }, basename(filePath)),
        h('span', { key: 'kind', style: badgeStyle }, data.kind === 'xlsx' ? 'XLSX' : (data.kind === 'tsv' ? 'TSV' : 'CSV')),
        dirty ? h('span', { key: 'dirty', style: { fontSize: 11, color: COLORS.brand } }, '● 未保存') : null,
        h('div', { key: 'actions', style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 } }, [
          saving ? h('span', { key: 'saving', style: { fontSize: 11, color: COLORS.secondary } }, '保存中…') : null,
          h('button', {
            key: 'save',
            type: 'button',
            disabled: !dirty || saving,
            onClick: saveNow,
            title: '保存到原文件（⌘S / Ctrl+S）',
            style: buttonStyle({ primary: true, disabled: !dirty || saving }),
          }, '保存'),
          h('button', {
            key: 'reload',
            type: 'button',
            disabled: saving,
            onClick: reloadNow,
            title: '丢弃未保存修改并重新读取文件',
            style: buttonStyle({ disabled: saving }),
          }, '重新加载'),
        ]),
      ])

      const statusMessage = saveError
        ? saveError
        : (savedAt
          ? '已保存 ' + new Date(savedAt).toLocaleTimeString()
          : (isXlsx ? '共 ' + (data.sheets || []).length + ' 个工作表' : '行 ' + totalRows + ' · 列 ' + totalCols))
      const statusBar = h('div', { key: 'status', style: statusBarStyle }, [
        h('span', {
          key: 'path',
          title: filePath,
          style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, filePath),
        h('span', {
          key: 'message',
          style: { marginLeft: 'auto', whiteSpace: 'nowrap', color: saveError ? COLORS.danger : COLORS.secondary },
        }, statusMessage),
      ])

      const warningBanner = isXlsx && Array.isArray(data.warnings) && data.warnings.length > 0
        ? h('div', {
          key: 'warnings',
          style: {
            padding: '4px 8px',
            fontSize: 11.5,
            color: COLORS.secondary,
            background: 'rgba(230, 160, 0, 0.10)',
            borderBottom: '1px solid ' + COLORS.border,
            flexShrink: 0,
          },
        }, '⚠ ' + data.warnings.join('；'))
        : null

      const sheetTabs = isXlsx
        ? h('div', {
          key: 'sheets',
          style: {
            display: 'flex',
            gap: 4,
            padding: '4px 8px',
            borderBottom: '1px solid ' + COLORS.border,
            background: COLORS.layer,
            flexShrink: 0,
            overflowX: 'auto',
          },
        }, (data.sheets || []).map((sheet, index) => {
          const count = countSheetEdits(edits, sheet.name)
          return h('button', {
            key: sheet.name + ':' + index,
            type: 'button',
            onClick: () => { setEditing(null); setActiveSheetIndex(index) },
            style: Object.assign(buttonStyle({ primary: index === activeSheetIndex }), { fontSize: 11.5 }),
          }, sheet.name + (count > 0 ? ' · ' + count : ''))
        }))
        : null

      const hiddenNotice = hiddenRows || hiddenCols
        ? h('div', { key: 'hidden', style: noticeStyle },
          '为保证流畅，仅显示前 ' + shownRows + ' 行 × ' + renderCols + ' 列（共 ' + totalRows + ' 行 × ' + totalCols + ' 列）；保存时会写入全部数据。')
        : null

      const footer = h('div', { key: 'footer', style: footerStyle }, [
        !isXlsx ? h('button', { key: 'add-row', type: 'button', onClick: addRow, style: buttonStyle({}) }, '+ 添加行') : null,
        !isXlsx ? h('button', { key: 'add-col', type: 'button', onClick: addColumn, style: buttonStyle({}) }, '+ 添加列') : null,
        h('span', {
          key: 'hint',
          style: { marginLeft: 'auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        }, '单击单元格编辑 · Enter 下移 · Tab 右移 · Esc 取消 · ⌘/Ctrl+S 保存'),
      ])

      return h('div', rootProps, [toolbar, statusBar, warningBanner, sheetTabs, hiddenNotice, renderGrid(), footer])
    }

    // ---------- 页签正文（从 useTabInfo 取地址） ----------

    function SheetTab(props) {
      const useTabInfo = props && props.useTabInfo
      let tab
      if (typeof useTabInfo === 'function') {
        try { tab = useTabInfo()?.tab } catch { tab = undefined }
      }
      const address = (tab && (tab.contentId || (tab.navigation && tab.navigation.address))) || ''
      const parsed = parseFileAddress(address)
      const sessionId = (parsed && parsed.sessionId) || (props && props.sessionId) || undefined
      const filePath = parsed ? parsed.path : ''
      const suffix = parsed ? suffixOf(parsed.path) : ''
      const fileKind = EXT_SET.has(suffix) ? suffix : ''
      // key=地址：不同文件切换时重建状态，避免把上一个文件的编辑/版本带到下一个
      return h(SheetEditor, {
        key: address || 'none',
        address: address,
        filePath: filePath,
        kind: fileKind,
        sessionId: sessionId,
      })
    }

    // ---------- 注册（保留已验证的 500ms 重试兜底） ----------

    function apply(ctx) {
      const debug = (window.__wbSheetsDebug = { at: Date.now(), attempts: 0, registered: false, errors: [] })
      let disposed = false
      let disposers = []
      function install() {
        if (disposed || debug.registered) return
        debug.attempts += 1
        const tabs = ctx.get('sidebarRightTabs')
        const slots = ctx.get('slots')
        if (tabs && typeof tabs.register === 'function' && slots && typeof slots.inject === 'function') {
          try {
            disposers.push(ctx.effect(() => tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              patterns: [FILE_PREFIX + '**'],
              priority: 'extension',
              canOpen,
              title: titleOf,
            }), 'workbench-sheets: tab type'))
            disposers.push(ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register(
              { name: 'sidebar.right.pane.tab', key: TAB_ID },
              SheetTab,
            )), 'workbench-sheets: tab body'))
            debug.registered = true
            debug.tabs = true
            debug.slots = true
          } catch (error) {
            debug.errors.push(String(error))
          }
          return
        }
        if (debug.attempts >= 40) {
          debug.errors.push('sidebarRightTabs/slots 一直不可用')
          return
        }
        window.setTimeout(install, 500)
      }
      install()
      ctx.effect(() => () => {
        disposed = true
        for (const dispose of disposers) { try { dispose() } catch (error) { /* ignore */ } }
        disposers = []
      }, 'workbench-sheets: teardown')
    }

    return { inject: ['slots'], apply }
  },
})
