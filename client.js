window.__ModuleLoader__.load({
  id: '@local/dsh-phoebe-voice',
  factory(require) {
    const { createElement: h, useEffect, useId, useRef, useState } = require('react')
    const NS = 'phoebeVoice.config'
    const KEY = 'FISH_API_KEY'
    const DEFAULT_VOICE = '8e80c3dcdf894213a10b48e9b08ad8c6'
    const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
    const zh = {
      summary: '配置 Fish Audio 密钥、参考音色和播报模式。',
      credentials: 'Fish Audio 凭据', keyLabel: 'API Key（FISH_API_KEY）', keyPlaceholder: '输入新的 Fish Audio API Key',
      keyHint: '密钥保存在 DSH 凭据库，不写入插件配置。已保存的密钥不会显示在这里。',
      keyLoading: '正在读取密钥状态…', keyPresent: '已配置密钥', keyMissing: '未配置密钥',
      keyUnavailable: '无法读取密钥状态。', keyNoPermission: '当前页面无权保存密钥。',
      keyInvalid: '请输入有效的单行 API Key。', keySaved: '密钥已保存，尚未向 Fish Audio 验证。',
      keySaveFailed: '未能确认密钥已保存。请检查连接和权限，再重新输入并保存。',
      saveKey: '保存密钥', saving: '保存中…',
      playback: '语音播报', voiceLabel: '音色 ID（reference_id）',
      voiceHint: '填写 Fish Audio 音色 ID，不是音色页面链接。修改后从下次播报开始使用。',
      restore: '使用默认菲比音色', invalidVoice: '请输入 1–128 位英文字母、数字、连字符或下划线。',
      mode: '播报模式', off: '关闭', notice: '仅固定提醒', brief: '朗读简短摘句',
      offHint: '不发送任何播报请求。',
      noticeHint: '只把固定中文提醒发给 Fish Audio，不发送问题或答复正文。',
      briefHint: '会把问题和最终答复的短摘句发给 Fish Audio。敏感会话建议使用「仅固定提醒」。',
      loading: '正在加载播报设置…', unavailable: '无法读取播报设置。请确认插件行已启用，然后重新打开此页。',
      readOnly: '当前页面无权保存播报设置。', conflict: '播报设置已在别处更新。请放弃草稿，再从已保存的设置继续编辑。',
      saveFailed: '未能确认播报设置已保存。请检查连接或权限，再核对已保存的值。', saved: '播报设置已保存。',
      saveVoice: '保存播报设置', discard: '放弃草稿',
      balance: 'Fish 余额', balanceRefresh: '点击刷新 Fish Audio API 余额',
      balanceUnavailable: '查询失败', balanceUnauthorized: '请检查 API Key',
      freeAvailable: '免费额度可用', freeExhausted: '免费额度已用完', freeUnknown: '免费额度状态未知',
    }
    const en = {
      summary: 'Configure the Fish Audio key, reference voice, and playback mode.',
      credentials: 'Fish Audio credentials', keyLabel: 'API key (FISH_API_KEY)', keyPlaceholder: 'Enter a new Fish Audio API key',
      keyHint: 'The key is kept in the DSH credential store, not in plugin settings. Saved keys are never displayed here.',
      keyLoading: 'Checking credential status…', keyPresent: 'Key configured', keyMissing: 'No key configured',
      keyUnavailable: 'Could not read credential status.', keyNoPermission: 'This page cannot save credentials.',
      keyInvalid: 'Enter a valid, single-line API key.', keySaved: 'Key saved. It has not been validated with Fish Audio.',
      keySaveFailed: 'Could not confirm the key was saved. Check the connection and permissions before entering it again.',
      saveKey: 'Save API key', saving: 'Saving…',
      playback: 'Voice announcements', voiceLabel: 'Voice ID (reference_id)',
      voiceHint: 'Enter a Fish Audio voice ID, not a voice page URL. Changes apply to the next announcement.',
      restore: 'Use default Phoebe voice', invalidVoice: 'Use 1–128 letters, digits, hyphens, or underscores.',
      mode: 'Playback mode', off: 'Off', notice: 'Fixed reminders only', brief: 'Read short excerpts',
      offHint: 'No synthesis requests are sent.',
      noticeHint: 'Sends only fixed Chinese reminders to Fish Audio, not questions or replies.',
      briefHint: 'Sends short excerpts from questions and final replies to Fish Audio. Use fixed reminders for sensitive sessions.',
      loading: 'Loading playback settings…', unavailable: 'Playback settings are unavailable. Check that the plugin row is enabled and reopen this page.',
      readOnly: 'This page cannot save playback settings.', conflict: 'Settings changed elsewhere. Discard this draft, then edit the saved settings again.',
      saveFailed: 'Could not confirm the save. Check the connection or permissions, then review the saved values.', saved: 'Playback settings saved.',
      saveVoice: 'Save playback settings', discard: 'Discard draft',
      balance: 'Fish balance', balanceRefresh: 'Click to refresh Fish Audio API balance',
      balanceUnavailable: 'Unavailable', balanceUnauthorized: 'Check API key',
      freeAvailable: 'Free credit available', freeExhausted: 'Free credit exhausted', freeUnknown: 'Free credit status unknown',
    }
    const css = `
      .phoebe-config { display:grid; gap:16px; max-width:720px; min-width:0; color:var(--dsw-alias-label-primary); }
      .phoebe-config__card { display:grid; gap:12px; min-width:0; margin:0; padding:12px 14px; border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); }
      .phoebe-config__heading { font-size:14px; font-weight:500; line-height:22px; margin:0; }
      .phoebe-config__field { display:grid; gap:6px; min-width:0; font-size:13px; line-height:20px; }
      .phoebe-config__input { box-sizing:border-box; width:100%; min-width:0; min-height:36px; padding:6px 8px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; }
      .phoebe-config__input[aria-invalid=true] { border-color:var(--dsw-alias-state-error-primary); }
      .phoebe-config__text,.phoebe-config__status { margin:0; font-size:13px; line-height:20px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
      .phoebe-config__status:empty { width:0; height:0; overflow:hidden; }
      .phoebe-config__status[data-tone=error] { color:var(--dsw-alias-state-error-primary); }
      .phoebe-config__actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
      .phoebe-config__button { box-sizing:border-box; min-height:36px; padding:0 12px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; cursor:pointer; }
      .phoebe-config__button[data-primary] { background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-bg-layer-2)); color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-label-primary)); }
      .phoebe-config__button:focus-visible,.phoebe-config__input:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
      .phoebe-config__button:disabled,.phoebe-config__input:disabled { opacity:.6; cursor:default; }
      @media (hover:hover) { .phoebe-config__button:not(:disabled):hover { border-color:var(--dsw-alias-brand-primary); } }
    `

    function actionsButton(label, attrs = {}) {
      return h('button', { type: 'button', className: 'phoebe-config__button', ...attrs }, label)
    }

    function status(t, key, tone) {
      return h('p', { role: 'status', className: 'phoebe-config__status', 'data-tone': tone }, key ? t(key) : '')
    }

    function KeyForm({ t, useRemoteAccess, credentials }) {
      const id = useId()
      const input = useRef(null)
      const busy = useRef(false)
      const [hasDraft, setHasDraft] = useState(false)
      const [info, setInfo] = useState(null)
      const [checkFailed, setCheckFailed] = useState(false)
      const [feedback, setFeedback] = useState(null)
      const [saving, setSaving] = useState(false)
      const canRead = useRemoteAccess('credentials/describe')
      const canWrite = useRemoteAccess('credentials/set')
      const canEdit = canWrite && info?.writable !== false
      const checking = canRead && !info && !checkFailed
      const editable = canEdit && !checking

      useEffect(() => {
        let current = true
        setInfo(null)
        setCheckFailed(false)
        if (canRead) {
          credentials.describe().then(result => {
            if (!current || busy.current) return
            if (result === null) setCheckFailed(true)
            else setInfo(result)
          }, () => { if (current && !busy.current) setCheckFailed(true) })
        }
        return () => { current = false }
      }, [canRead, credentials])

      async function save(event) {
        event.preventDefault()
        if (!editable || busy.current || !input.current) return
        const key = input.current.value.trim()
        if (!key || !/^[!-~]{1,4096}$/.test(key)) {
          setFeedback({ key: 'keyInvalid', tone: 'error' })
          return
        }
        busy.current = true
        setSaving(true)
        setFeedback(null)
        try {
          if (!await credentials.set(key)) throw new Error('refused')
          if (input.current) input.current.value = ''
          setHasDraft(false)
          setInfo({ configured: true, writable: true })
          setCheckFailed(false)
          setFeedback({ key: 'keySaved', tone: 'success' })
        } catch {
          setFeedback({ key: 'keySaveFailed', tone: 'error' })
        } finally {
          busy.current = false
          setSaving(false)
        }
      }

      const current = info ? (info.configured ? 'keyPresent' : 'keyMissing')
        : checking ? 'keyLoading' : 'keyUnavailable'
      return h('form', { className: 'phoebe-config__card', onSubmit: save, 'aria-labelledby': `${id}-title` },
        h('h4', { className: 'phoebe-config__heading', id: `${id}-title` }, t('credentials')),
        h('p', { className: 'phoebe-config__text', id: `${id}-hint` }, t('keyHint')),
        status(t, current, info?.configured ? 'success' : undefined),
        h('label', { className: 'phoebe-config__field', htmlFor: id }, t('keyLabel'),
          h('input', {
            id, ref: input, type: 'password', className: 'phoebe-config__input', autoComplete: 'new-password',
            spellCheck: false, autoCapitalize: 'none', maxLength: 4096, disabled: !editable || saving,
            placeholder: t('keyPlaceholder'), 'aria-describedby': `${id}-hint`,
            onInput: (event) => {
              setHasDraft(Boolean(event.currentTarget.value.trim()))
              setFeedback(null)
            },
          })),
        !canEdit && status(t, 'keyNoPermission'),
        h('div', { className: 'phoebe-config__actions' },
          actionsButton(t(saving ? 'saving' : 'saveKey'), { type: 'submit', 'data-primary': true, disabled: !editable || saving || !hasDraft }),
          status(t, feedback?.key, feedback?.tone)),
      )
    }

    function PlaybackForm({ t, form, useRemoteAccess }) {
      const id = useId()
      const busy = useRef(false)
      const [draft, setDraft] = useState(null)
      const [feedback, setFeedback] = useState(null)
      const [saving, setSaving] = useState(false)
      const state = form?.state
      const current = state?.value
      const ready = state?.status === 'ready' && current && Number.isSafeInteger(state.revision)
      const mode = draft?.mode ?? current?.mode ?? 'off'
      const voiceId = draft?.voiceId ?? current?.reference_id ?? DEFAULT_VOICE
      const invalid = !ID_PATTERN.test(voiceId.trim())
      const conflict = draft !== null && draft.revision !== state?.revision
      const canWrite = useRemoteAccess('settings/mutate')
      const writable = Boolean(ready && state.writable && canWrite)
      const changed = Boolean(draft && (mode !== current?.mode || voiceId.trim() !== current?.reference_id))

      function edit(patch) {
        setDraft(before => ({ revision: state.revision, ...before, ...patch }))
        setFeedback(null)
      }

      async function save(event) {
        event.preventDefault()
        if (!writable || invalid || conflict || !changed || busy.current) return
        const ops = []
        if (voiceId.trim() !== current.reference_id) ops.push({ op: 'set', path: ['reference_id'], value: voiceId.trim() })
        if (mode !== current.mode) ops.push({ op: 'set', path: ['mode'], value: mode })
        busy.current = true
        setSaving(true)
        setFeedback(null)
        try {
          if (!await form.mutate(ops, draft.revision)) throw new Error('refused')
          setDraft(null)
          setFeedback({ key: 'saved', tone: 'success' })
        } catch {
          setFeedback({ key: 'saveFailed', tone: 'error' })
        } finally {
          busy.current = false
          setSaving(false)
        }
      }

      const disabled = !writable || saving || conflict
      return h('form', { className: 'phoebe-config__card', onSubmit: save, 'aria-labelledby': `${id}-title` },
        h('h4', { className: 'phoebe-config__heading', id: `${id}-title` }, t('playback')),
        !ready ? status(t, state?.status === 'loading' ? 'loading' : 'unavailable') : h('div', { className: 'phoebe-config' },
          h('div', { className: 'phoebe-config__field' },
            h('label', { htmlFor: `${id}-voice` }, t('voiceLabel')),
            h('input', {
              id: `${id}-voice`, className: 'phoebe-config__input', type: 'text', value: voiceId,
              autoComplete: 'off', spellCheck: false, autoCapitalize: 'none', maxLength: 160,
              disabled, 'aria-invalid': invalid || undefined, 'aria-describedby': `${id}-voice-hint${invalid ? ` ${id}-invalid` : ''}`,
              onChange: (event) => edit({ voiceId: event.currentTarget.value }),
            }),
            h('p', { id: `${id}-voice-hint`, className: 'phoebe-config__text' }, t('voiceHint')),
            invalid && h('p', { id: `${id}-invalid`, className: 'phoebe-config__status', 'data-tone': 'error' }, t('invalidVoice')),
            h('div', { className: 'phoebe-config__actions' }, actionsButton(t('restore'), {
              disabled: disabled || voiceId === DEFAULT_VOICE, onClick: () => edit({ voiceId: DEFAULT_VOICE }),
            }))),
          h('div', { className: 'phoebe-config__field' },
            h('label', { htmlFor: `${id}-mode` }, t('mode')),
            h('select', {
              id: `${id}-mode`, className: 'phoebe-config__input', value: mode, disabled,
              'aria-describedby': `${id}-mode-hint`, onChange: (event) => edit({ mode: event.currentTarget.value }),
            }, ['off', 'notice', 'brief'].map(value => h('option', { key: value, value }, t(value)))),
            h('p', { id: `${id}-mode-hint`, className: 'phoebe-config__text' }, t(`${mode}Hint`))),
          !writable && status(t, 'readOnly'),
          conflict && status(t, 'conflict', 'error'),
          h('div', { className: 'phoebe-config__actions' },
            actionsButton(t(saving ? 'saving' : 'saveVoice'), {
              type: 'submit', 'data-primary': true, disabled: disabled || invalid || !changed,
            }),
            draft && actionsButton(t('discard'), { disabled: saving, onClick: () => { setDraft(null); setFeedback(null) } }),
            status(t, conflict ? null : feedback?.key, feedback?.tone)),
        ),
      )
    }

    const balanceCss = `
      .phoebe-balance { box-sizing:border-box; display:inline-flex; align-items:center; min-width:0; max-width:100%; margin-inline-start:auto; }
      .phoebe-balance__button { min-width:0; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        border:1px solid var(--dsw-alias-border-l1); border-radius:999px; padding:0 7px; background:var(--dsw-alias-bg-layer-1);
        color:var(--dsw-alias-label-secondary); cursor:pointer; font:inherit; font-size:11px; line-height:20px; font-variant-numeric:tabular-nums; }
      .phoebe-balance__button:hover { color:var(--dsw-alias-label-primary); }
      .phoebe-balance__button:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
      .phoebe-balance__button[aria-busy=true] { opacity:.65; }
    `

    function BalanceBadge({ t }) {
      const [balance, setBalance] = useState(null)
      const [busy, setBusy] = useState(false)
      const refresh = useRef(null)
      useEffect(() => {
        const lifetime = new AbortController()
        let pending = false
        let lastStarted = -Infinity
        const load = async () => {
          if (pending || lifetime.signal.aborted) return
          pending = true
          lastStarted = Date.now()
          setBusy(true)
          try {
            // Same authenticated, base-relative API URL as DSH's native Fetch routes.
            const response = await fetch('api/phoebe-voice.balance', { signal: lifetime.signal, cache: 'no-store' })
            const result = response.ok ? await response.json() : null
            if (!lifetime.signal.aborted) setBalance(result)
          } catch {
            if (!lifetime.signal.aborted) setBalance(previous => previous ? { status: 'unavailable' } : null)
          } finally {
            pending = false
            if (!lifetime.signal.aborted) setBusy(false)
          }
        }
        const refreshVisible = () => {
          if (!document.hidden && Date.now() - lastStarted >= 120_000) void load()
        }
        refresh.current = load
        refreshVisible()
        const timer = setInterval(refreshVisible, 120_000)
        document.addEventListener('visibilitychange', refreshVisible)
        return () => {
          lifetime.abort()
          clearInterval(timer)
          document.removeEventListener('visibilitychange', refreshVisible)
          refresh.current = null
        }
      }, [])

      if (!['ok', 'unavailable', 'unauthorized'].includes(balance?.status)) return null
      const detail = balance.status === 'ok'
        ? [balance.credit, t(balance.hasFreeCredit === true ? 'freeAvailable' : balance.hasFreeCredit === false ? 'freeExhausted' : 'freeUnknown')].join(' · ')
        : t(balance.status === 'unauthorized' ? 'balanceUnauthorized' : 'balanceUnavailable')
      const label = t('balance') + ' · ' + detail
      const title = label + ' — ' + t('balanceRefresh')
      return h('span', { className: 'phoebe-balance' }, h('style', null, balanceCss),
        h('button', { type: 'button', className: 'phoebe-balance__button', 'aria-busy': busy, title,
          'aria-label': title, onClick: () => { void refresh.current?.() } }, label))
    }

    function Page(props) {
      if (props.view === 'summary') return props.t('summary')
      return h('div', { className: 'phoebe-config' }, h('style', null, css), h(KeyForm, props), h(PlaybackForm, props))
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.credentials'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'phoebe-voice: settings translations')
        const credentials = {
          async describe() {
            const result = await ctx.remote.credentials.describe([KEY])
            const info = result.ok ? result.value[KEY] : undefined
            // Don't forward the optional masked preview or any provider-side error text.
            return info ? { configured: info.configured, writable: info.writable } : null
          },
          async set(key) { return (await ctx.remote.credentials.set(KEY, key)).ok },
        }
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'phoebe-voice.balance', order: 50, locale: NS,
        }, BalanceBadge))
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config', key: '@local/dsh-phoebe-voice#phoebe-voice', locale: NS,
          inject: () => ({ credentials }),
        }, Page))
      },
    }
  },
})
