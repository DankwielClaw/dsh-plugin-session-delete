window.__ModuleLoader__.load({
  id: '@dankwielclaw/dsh-plugin-session-delete',
  factory: (require) => {
    const React = require('react')
    const { useState } = React
    const { IconTrashOutline16, MenuItemButton, Modal, Button } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const EVENT = 'gunthe:delete-session'
    const API = '/api/gunthe-session-delete/delete'

    const messages = {
      en: {
        menu: 'Delete permanently', title: 'Permanently delete session', cancel: 'Cancel', confirm: 'Delete permanently',
        description: 'This permanently deletes the conversation history. It cannot be undone.',
        label: 'Session', id: 'Session ID', type: 'Type DELETE to confirm', mismatch: 'Enter DELETE exactly.',
        active: 'This session is still active. Stop it and restart Gunthe before deleting it.', deleting: 'Deleting…',
      },
      zh: {
        menu: '永久刪除', title: '永久刪除 Session', cancel: '取消', confirm: '永久刪除',
        description: '呢個操作會永久刪除全部對話記錄，而且無法復原。',
        label: 'Session', id: 'Session ID', type: '輸入 DELETE 以確認', mismatch: '請準確輸入 DELETE。',
        active: 'Session 仍然處於啟用狀態。請先停止，再重啟 Gunthe 後刪除。', deleting: '刪除中…',
      },
    }
    const lang = () => /^zh/i.test(navigator.language || '') ? 'zh' : 'en'
    const t = (key) => messages[lang()][key] || key

    function openDialog(sessionId, title) {
      window.dispatchEvent(new CustomEvent(EVENT, { detail: { sessionId, title } }))
    }

    function DeleteMenuItem(props) {
      const [, setMenuOpen] = props.useMenuOpenState ? props.useMenuOpenState() : [false, () => {}]
      const source = props.ctx.workspaces.list
      React.useSyncExternalStore(
        (listener) => source.subscribe(listener),
        () => source.getSnapshot(),
      )
      return h(MenuItemButton, {
        icon: h(IconTrashOutline16, { size: 14 }),
        onSelect: () => {
          setMenuOpen(false)
          const archived = source.getSnapshot().archivedSessionIds.includes(props.sessionId)
          if (!archived) {
            window.alert(lang() === 'zh' ? '請先 Archive 呢個 Session，再喺 Archived 清單永久刪除。' : 'Archive this session first, then permanently delete it from the Archived list.')
            return
          }
          openDialog(props.sessionId, props.displayTitle)
        },
        danger: true,
        separatorBefore: true,
      }, t('menu'))
    }

    function DeleteDialog(props) {
      const [target, setTarget] = useState(null)
      const [confirmation, setConfirmation] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      React.useEffect(() => {
        const handler = (event) => {
          const detail = event.detail || {}
          if (!detail.sessionId) return
          setTarget({ sessionId: detail.sessionId, title: detail.title || detail.sessionId })
          setConfirmation('')
          setBusy(false)
          setError('')
        }
        window.addEventListener(EVENT, handler)
        return () => window.removeEventListener(EVENT, handler)
      }, [])

      if (!target) return null
      const close = () => { if (!busy) setTarget(null) }
      const confirm = async () => {
        if (confirmation !== 'DELETE' || busy) return
        setBusy(true)
        setError('')
        try {
          const response = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-gunthe-plugin': 'session-delete' },
            body: JSON.stringify({ sessionId: target.sessionId }),
          })
          const body = await response.json().catch(() => ({}))
          if (!response.ok || !body.ok) {
            const err = new Error(body?.error?.message || `HTTP ${response.status}`)
            err.code = body?.error?.code
            throw err
          }
          const deletedId = target.sessionId
          setTarget(null)
          await props.ctx.sessions.refresh()
          const snapshot = props.ctx.sessions.list.getSnapshot()
          if (snapshot.ids.includes(deletedId)) {
            window.location.reload()
            return
          }
          // A clean reload lets the workspace navigation policy replace a
          // deleted current selection; other connected clients already receive
          // api-session/removed and update their lists immediately.
          window.location.reload()
        } catch (reason) {
          setBusy(false)
          setError(reason?.code === 'SESSION_ACTIVE' ? t('active') : (reason?.message || String(reason)))
        }
      }

      return h(Modal, {
        open: true,
        onClose: close,
        closeLabel: t('cancel'),
        title: t('title'),
        description: t('description'),
        footer: h(React.Fragment, null,
          h(Button, { variant: 'outline', disabled: busy, onClick: close }, t('cancel')),
          h(Button, {
            variant: 'outline', disabled: busy || confirmation !== 'DELETE', onClick: confirm,
            style: { color: 'var(--dsw-alias-state-error-primary, #d33)' },
          }, busy ? t('deleting') : t('confirm')),
        ),
      }, h('div', null,
        h('div', { style: { marginBottom: 8 } }, `${t('label')}: ${target.title}`),
        h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginBottom: 16 } }, `${t('id')}: ${target.sessionId}`),
        h('label', { style: { display: 'grid', gap: 6 } },
          h('span', null, t('type')),
          h('input', {
            value: confirmation, disabled: busy, autoFocus: true,
            onChange: (event) => setConfirmation(event.target.value),
            style: { padding: '8px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)' },
          }),
        ),
        confirmation && confirmation !== 'DELETE' ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', marginTop: 6, fontSize: 12 } }, t('mismatch')) : null,
        error ? h('div', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', marginTop: 10 } }, error) : null,
      ))
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item', id: 'gunthe-session-delete', order: 500,
      }, (props) => h(DeleteMenuItem, { ...props, ctx })))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'gunthe-session-delete-dialog', order: 500,
      }, (props) => h(DeleteDialog, { ...props, ctx })))
    }

    return { apply, inject: ['slots', 'sessions', 'workspaces'] }
  },
})
