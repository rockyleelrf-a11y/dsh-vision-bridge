window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-vision-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const Primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const Tooltip = Primitives.Tooltip;

    const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    function bytesToBase64(bytes) {
      let out = ''
      for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2]
        out += B64_CHARS[b0 >> 2]
        out += B64_CHARS[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)]
        out += b1 === undefined ? '=' : B64_CHARS[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 2)]
        out += b2 === undefined ? '=' : B64_CHARS[b2 & 63]
      }
      return out
    }

    /** Camera icon (user-provided icon/camera.svg, 1024 viewBox, solid). */
    function CameraIcon() {
      return React.createElement('svg', {
        viewBox: '0 0 1024 1024',
        width: 16,
        height: 16,
        fill: 'currentColor',
        'aria-hidden': true
      },
        React.createElement('path', { d: 'M784 272H644.8L624 209.6c-12.8-40-49.6-65.6-91.2-65.6H318.4c-41.6 0-78.4 25.6-91.2 65.6l-22.4 65.6c-72 16-126.4 80-126.4 156.8v320c0 88 72 160 160 160h544c88 0 160-72 160-160V432C944 344 872 272 784 272z m-496-41.6c4.8-12.8 16-22.4 30.4-22.4h214.4c14.4 0 25.6 8 30.4 22.4l14.4 41.6H275.2l12.8-41.6zM880 752c0 52.8-43.2 96-96 96H240c-52.8 0-96-43.2-96-96V432c0-52.8 43.2-96 96-96h544c52.8 0 96 43.2 96 96v320z' }),
        React.createElement('path', { d: 'M752 240h64c17.6 0 32-14.4 32-32s-14.4-32-32-32h-64c-17.6 0-32 14.4-32 32s14.4 32 32 32zM512 432c-88 0-160 72-160 160s72 160 160 160 160-72 160-160-72-160-160-160z m0 256c-52.8 0-96-43.2-96-96s43.2-96 96-96 96 43.2 96 96-43.2 96-96 96z' })
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      slots.inject('conversation.input.left', () => slots.register(
        { name: 'conversation.input.left', id: 'vision-bridge-upload', order: 10 },
        (props) => {
          const input = props && props.input
          const inputActions = props && props.inputActions
          const fileRef = React.useRef(null)
          const [status, setStatus] = React.useState('idle')
          const [busy, setBusy] = React.useState(false)
          // Vision API connectivity: null = probing, ok = green, error = red.
          const [vision, setVision] = React.useState(null)
          const refreshStatus = React.useCallback(async (force) => {
            try {
              const response = await fetch('/vision-status' + (force ? '?refresh=1' : ''))
              const data = await response.json()
              setVision(data && data.status ? data : { status: 'error', detail: '状态响应异常' })
            } catch (error) {
              setVision({ status: 'error', detail: '状态查询失败' })
            }
          }, [])
          React.useEffect(() => { refreshStatus(false) }, [refreshStatus])
          // Dropdown states
          const [dropdownOpen, setDropdownOpen] = React.useState(false)
          const [availableModels, setAvailableModels] = React.useState(null) // null = not loaded, [] = empty
          const dropdownRef = React.useRef(null)
          // Close dropdown when clicking outside
          React.useEffect(() => {
            if (!dropdownOpen) return
            const handler = (e) => {
              if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setDropdownOpen(false)
            }
            document.addEventListener('mousedown', handler)
            return () => document.removeEventListener('mousedown', handler)
          }, [dropdownOpen])
          const toggleDropdown = React.useCallback(async () => {
            if (dropdownOpen) { setDropdownOpen(false); return }
            if (availableModels === null) {
              try {
                const r = await fetch('/vision-models')
                const d = await r.json()
                setAvailableModels(d.models || [])
              } catch (e) {
                setAvailableModels([])
              }
            }
            setDropdownOpen(true)
          }, [dropdownOpen, availableModels])
          const onPick = () => { if (fileRef.current) fileRef.current.click() }
          const onChange = async (event) => {
            const file = event.target.files && event.target.files[0]
            if (event.target) event.target.value = ''
            if (!file || busy) return
            setBusy(true)
            setStatus('uploading')
            try {
              const buf = new Uint8Array(await file.arrayBuffer())
              const dataUrl = 'data:' + (file.type || 'application/octet-stream') + ';base64,' + bytesToBase64(buf)
              const response = await fetch('/vision-upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: file.name, dataUrl })
              })
              const result = await response.json()
              if (!response.ok || !result || typeof result.path !== 'string') {
                throw new Error((result && result.error) ? result.error : ('上传失败（HTTP ' + response.status + '）'))
              }
              const current = input && typeof input.draft === 'string' ? input.draft : ''
              const instruction = '请用 vision_analyze 工具分析这张图片：' + result.path
              if (inputActions && typeof inputActions.setDraft === 'function') {
                inputActions.setDraft(current ? current + '\n' + instruction : instruction)
              }
              setStatus('ok')
              refreshStatus(true)
            } catch (error) {
              console.error('vision upload failed', error)
              setStatus('error')
            } finally {
              setBusy(false)
            }
          }
          const statusText = status === 'uploading' ? '上传中…' : status === 'ok' ? '已上传，回车发送' : status === 'error' ? '上传失败' : null
          const statusColor = status === 'ok' ? '#2e7d32' : status === 'error' ? '#c62828' : '#888'
          const dotColor = vision === null ? '#b0b0b0' : vision.status === 'ok' ? '#22c55e' : '#ef4444'
          const dotLabel = vision === null ? '检测中' : vision.status === 'ok' ? '视觉已连接' : '未连接'
          const breatheCss = '@keyframes vb-breathe{0%,100%{opacity:1}50%{opacity:.35}}'
          const cameraBtn = React.createElement('button', {
            type: 'button',
            disabled: busy,
            onClick: onPick,
            'aria-label': '识图能力已装载 · 点击上传图片识别',
            style: { background: 'transparent', border: 'none', cursor: busy ? 'wait' : 'pointer', color: 'inherit', opacity: busy ? 0.45 : 1, padding: '2px 4px', lineHeight: 1, display: 'inline-flex', alignItems: 'center' }
          }, React.createElement(CameraIcon, null))
          const statusBadge = React.createElement('span', {
            ref: dropdownRef,
            style: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', padding: '1px 6px', borderRadius: 10, background: 'rgba(127,127,127,.12)', fontSize: 11, lineHeight: '16px', color: 'inherit', flex: 'none', userSelect: 'none' }
          },
            React.createElement('span', {
              onClick: toggleDropdown,
              style: { display: 'inline-flex', alignItems: 'center', gap: 4 }
            },
              React.createElement('span', { style: { width: 7, height: 7, borderRadius: '50%', background: dotColor, animation: 'vb-breathe 1.6s ease-in-out infinite', flex: 'none' } }),
              React.createElement('span', { children: dotLabel }),
              React.createElement('span', { style: { fontSize: 9, marginLeft: 2, color: dotColor, opacity: 0.85 }, children: '▼' })
            ),
            dropdownOpen && React.createElement('div', {
              style: { position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, zIndex: 1000, background: 'var(--dsw-specific-menu, #fff)', border: '1px solid var(--dsw-alias-border-l2, #e0e0e0)', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.12)', minWidth: 200, maxHeight: 240, overflow: 'auto', padding: 4 }
            },
              availableModels === null
                ? React.createElement('div', { style: { padding: '6px 8px', fontSize: 11, color: '#888' }, children: '加载中…' })
                : availableModels.length === 0
                  ? React.createElement('div', { style: { padding: '6px 8px', fontSize: 11, color: '#c62828', lineHeight: 1.4 }, children: '未检测到多模态模型。请检查 settings.yaml 中是否配置了 `input: [text, image]` 的视觉模型。' })
                  : availableModels.map((m) =>
                      React.createElement('div', {
                        key: m.provider + '/' + m.model,
                        onClick: () => { setDropdownOpen(false); refreshStatus(true) },
                        style: { padding: '5px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, background: (vision && vision.model === m.model && vision.provider === m.provider) ? 'rgba(34,197,94,0.1)' : 'transparent' }
                      },
                        React.createElement('span', { style: { width: 6, height: 6, borderRadius: '50%', background: '#22c55e', flex: 'none' } }),
                        React.createElement('span', { style: { flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, children: m.model }),
                        React.createElement('span', { style: { fontSize: 10, color: '#888', flex: 'none' }, children: m.provider })
                      )
                    )
            )
          )
          return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginRight: 2 } },
            React.createElement('style', { children: breatheCss }),
            React.createElement(Tooltip, { label: '识图能力已装载 · 点击上传图片识别', side: 'top' }, cameraBtn),
            statusBadge,
            statusText === null ? null : React.createElement('span', { style: { fontSize: 11, color: statusColor } }, statusText),
            React.createElement('input', {
              ref: fileRef,
              type: 'file',
              accept: 'image/png,image/jpeg,image/webp,image/gif',
              style: { display: 'none' },
              onChange: onChange
            })
          )
        }
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports;
  }
});
