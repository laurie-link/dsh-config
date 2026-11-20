/**
 * dsh-personalization — Client half.
 *
 * 一个「个性化」设置分区：六行下拉，和 ChatGPT 的设置页同构。值来自 Host 的
 * `/dsh-personalization/config`，改动立刻 POST 到 `/dsh-personalization/set`
 * 写进 ~/.dsh/personalization.json，下一轮对话的系统提示词就带着新规则。
 *
 * Plain-JS client plugin, no build: only the loader-provided `react` module is
 * required, and every visible string is Chinese because this plugin exists to
 * mirror a Chinese UI.
 */

window.__ModuleLoader__.load({
  id: 'dsh-personalization',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const ROUTE = 'dsh-personalization'
    const STYLE_ID = 'dsh-personalization-style'

    const ROWS = [
      {
        key: 'tone',
        title: '基础风格和语气',
        desc: '选择回答的整体语气和风格。',
      },
      {
        key: 'detail',
        title: '细节层级',
        desc: '选择回答里报不报具体的文件、代码和字段名。',
      },
      {
        key: 'jargon',
        title: '术语和用词',
        desc: '选择回答更偏日常说法，还是更偏专业术语。',
      },
      {
        key: 'friendliness',
        title: '亲切程度',
        desc: '选择回答听起来有多亲切。',
      },
      {
        key: 'enthusiasm',
        title: '热情程度',
        desc: '选择回答听起来有多热情。',
      },
      {
        key: 'emoji',
        title: '表情符号',
        desc: '选择回答使用表情符号的频率。',
      },
      {
        key: 'visual',
        title: '可视化回答',
        desc: '在标准文字回答和带更多可视化、交互内容的回答之间选择。',
      },
      {
        key: 'media',
        title: '配图',
        desc: '选择回答里出现具体东西时插图的手劲。',
      },
      {
        key: 'headings',
        title: '标题和列表',
        desc: '选择回答使用标题和列表的频率。',
      },
    ]

    const CSS = `
.dsh-pers { padding: 4px 2px 48px; color: inherit; }
.dsh-pers-head { display: flex; align-items: baseline; gap: 10px; margin: 2px 0 8px; }
.dsh-pers-title { font-size: 20px; font-weight: 650; letter-spacing: .2px; }
.dsh-pers-saved { font-size: 12px; opacity: .55; transition: opacity .2s ease; }
.dsh-pers-sub { font-size: 13px; line-height: 1.55; opacity: .6; margin: 0 0 14px; max-width: 620px; }
.dsh-pers-list { display: flex; flex-direction: column; }
.dsh-pers-row { display: flex; align-items: center; justify-content: space-between; gap: 28px; padding: 18px 2px; border-top: 1px solid color-mix(in srgb, currentColor 11%, transparent); }
.dsh-pers-row:first-child { border-top: none; }
.dsh-pers-text { min-width: 0; }
.dsh-pers-label { font-size: 14px; font-weight: 600; margin-bottom: 5px; }
.dsh-pers-desc { font-size: 13px; line-height: 1.45; opacity: .58; }
.dsh-pers-rule { margin-top: 7px; font-size: 12px; line-height: 1.5; opacity: .42; }
.dsh-pers-preview { margin-top: 10px; padding: 12px 14px; border-radius: 10px; font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: color-mix(in srgb, currentColor 6%, transparent); border: 1px solid color-mix(in srgb, currentColor 11%, transparent); max-height: 320px; overflow: auto; }
.dsh-pers-toggle { border: 1px solid color-mix(in srgb, currentColor 17%, transparent); background: color-mix(in srgb, currentColor 8%, transparent); border-radius: 8px; padding: 5px 12px; font: inherit; font-size: 12px; color: inherit; cursor: pointer; }
.dsh-pers-toggle:hover { border-color: color-mix(in srgb, currentColor 30%, transparent); }
.dsh-pers-files { margin-top: 20px; font-size: 12px; line-height: 1.7; opacity: .4; word-break: break-all; }
.dsh-pers-select { -webkit-appearance: none; appearance: none; flex: none; min-width: 118px; padding: 8px 32px 8px 16px; border-radius: 10px; font-size: 13px; font-weight: 500; font-family: inherit; color: inherit; cursor: pointer; border: 1px solid color-mix(in srgb, currentColor 17%, transparent); background-color: color-mix(in srgb, currentColor 9%, transparent); background-repeat: no-repeat; background-position: right 12px center; background-size: 10px 6px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238b8b8b' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E"); }
.dsh-pers-select:hover { border-color: color-mix(in srgb, currentColor 32%, transparent); }
.dsh-pers-select:focus-visible { outline: 2px solid color-mix(in srgb, currentColor 35%, transparent); outline-offset: 2px; }
.dsh-pers-select option { color: #1b1b1b; background: #f7f7f7; }
.dsh-pers-foot { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 20px; font-size: 12px; opacity: .55; line-height: 1.5; }
.dsh-pers-reset { flex: none; border: none; background: none; padding: 4px 2px; font: inherit; color: inherit; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; opacity: .9; }
.dsh-pers-reset:disabled { opacity: .4; cursor: default; }
.dsh-pers-err { margin-top: 12px; font-size: 13px; color: #e5484d; }
`

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function api(path, init) {
      const url = new URL(`${ROUTE}/${path}`, document.baseURI)
      return fetch(url, init).then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        return body
      })
    }

    function renderPreview(values, rules) {
      if (values === null || rules === null) return ''
      const lines = []
      for (const row of ROWS) {
        const value = values[row.key] ?? 'default'
        if (value === 'default') continue
        const rule = rules?.[row.key]?.[value]
        if (typeof rule === 'string' && rule !== '') lines.push(`- ${rule}`)
      }
      if (lines.length === 0) return ''
      return `## 回答风格（用户个性化设置，优先于默认写作习惯）\n${lines.join('\n')}\n以上风格只改表达方式，不改事实、不改安全边界、不改工具用法。`
    }

    function Row({ row, options, value, rule, disabled, onChange }) {
      return h(
        'div',
        { className: 'dsh-pers-row' },
        h(
          'div',
          { className: 'dsh-pers-text' },
          h('div', { className: 'dsh-pers-label' }, row.title),
          h('div', { className: 'dsh-pers-desc' }, row.desc),
          rule === '' || rule === undefined ? null : h('div', { className: 'dsh-pers-rule' }, rule),
        ),
        h(
          'select',
          {
            className: 'dsh-pers-select',
            value: value ?? 'default',
            disabled,
            'aria-label': row.title,
            onChange: (event) => onChange(row.key, event.target.value),
          },
          (options ?? []).map(([candidate, label]) => h('option', { key: candidate, value: candidate }, label)),
        ),
      )
    }

    function PersonalizationSection() {
      const [values, setValues] = useState(null)
      const [options, setOptions] = useState(null)
      const [saving, setSaving] = useState('')
      const [savedFlash, setSavedFlash] = useState(false)
      const [error, setError] = useState('')
      const [configPath, setConfigPath] = useState('')
      const [rules, setRules] = useState(null)
      const [files, setFiles] = useState(null)
      const [dir, setDir] = useState('')
      const [serverPreview, setServerPreview] = useState('')
      const [showPreview, setShowPreview] = useState(false)

      useEffect(() => {
        ensureStyle()
        let alive = true
        api('config')
          .then((body) => {
            if (!alive) return
            setValues(body.values)
            setOptions(body.options)
            setConfigPath(body.path ?? '')
            setRules(body.rules ?? null)
            setFiles(body.files ?? null)
            setDir(body.dir ?? '')
            setServerPreview(body.preview ?? '')
          })
          .catch((cause) => {
            if (alive) setError(`读取设置失败：${cause.message}`)
          })
        return () => {
          alive = false
        }
      }, [])

      useEffect(() => {
        if (!savedFlash) return undefined
        const timer = window.setTimeout(() => setSavedFlash(false), 1600)
        return () => window.clearTimeout(timer)
      }, [savedFlash])

      const update = useCallback(
        (key, value) => {
          const previous = values
          setValues({ ...(values ?? {}), [key]: value })
          setSaving(key)
          setError('')
          api('set', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key, value }),
          })
            .then((body) => {
              setValues(body.values)
              setServerPreview(body.preview ?? '')
              setSavedFlash(true)
            })
            .catch((cause) => {
              setValues(previous)
              setError(`保存失败：${cause.message}`)
            })
            .finally(() => setSaving(''))
        },
        [values],
      )

      const resetAll = useCallback(() => {
        if (options === null || values === null) return
        const dirty = ROWS.map((row) => row.key).filter((key) => (values[key] ?? 'default') !== 'default')
        if (dirty.length === 0) return
        const previous = values
        const draft = { ...values }
        for (const key of dirty) draft[key] = 'default'
        setValues(draft)
        setSaving('all')
        setError('')
        Promise.all(
          dirty.map((key) =>
            api('set', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ key, value: 'default' }),
            }),
          ),
        )
          .then(() => api('config'))
          .then((body) => {
            setValues(body.values)
            setFiles(body.files ?? null)
            setServerPreview(body.preview ?? '')
            setSavedFlash(true)
          })
          .catch((cause) => {
            setValues(previous)
            setError(`恢复默认失败：${cause.message}`)
          })
          .finally(() => setSaving(''))
      }, [options, values])

      const previewText = renderPreview(values, rules)
      // The host composes the whole section (generated block + every instruction
      // document), so prefer its text; the local render is the optimistic fallback.
      const fullText = serverPreview !== '' ? serverPreview : previewText
      const loading = values === null || options === null

      return h(
        'section',
        { className: 'dsh-pers' },
        h(
          'div',
          { className: 'dsh-pers-head' },
          h('div', { className: 'dsh-pers-title' }, '个性化'),
          h('div', { className: 'dsh-pers-saved' }, savedFlash ? '已保存' : ''),
        ),
        h(
          'p',
          { className: 'dsh-pers-sub' },
          '这些选项会写进系统提示词，从下一轮回复开始生效。每一项的「默认」表示不额外约束，交给模型按上下文判断。',
        ),
        h(
          'div',
          { className: 'dsh-pers-list' },
          ROWS.map((row) =>
            h(Row, {
              key: row.key,
              row,
              options: options?.[row.key],
              value: values?.[row.key],
              rule:
                values === null || rules === null || (values[row.key] ?? 'default') === 'default'
                  ? ''
                  : rules?.[row.key]?.[values[row.key]] ?? '',
              disabled: loading || saving !== '',
              onChange: update,
            }),
          ),
        ),
        files === null || files.length === 0 ? null : h(
          'div',
          { className: 'dsh-pers-files' },
          `参与注入的文档：${files.map((file) => file.name).join(' · ')}（${dir}）`,
        ),
        fullText === '' ? null : h(
          'div',
          null,
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-pers-toggle',
              onClick: () => setShowPreview((open) => !open),
            },
            showPreview ? '收起完整提示词' : '查看完整提示词',
          ),
          showPreview ? h('pre', { className: 'dsh-pers-preview' }, fullText) : null,
        ),
        error === '' ? null : h('div', { className: 'dsh-pers-err' }, error),
        h(
          'div',
          { className: 'dsh-pers-foot' },
          h('span', null, configPath === '' ? '保存在 ~/.dsh/personalization.json' : `保存在 ${configPath}`),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-pers-reset',
              disabled: loading || saving !== '',
              onClick: resetAll,
            },
            '全部恢复默认',
          ),
        ),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          {
            name: 'settings.section',
            id: 'personalization',
            order: 25,
            label: () => '个性化',
          },
          PersonalizationSection,
        )
      })
    }

    return { inject: ['slots'], apply }
  },
})
