window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-vision-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

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

    /** Linear (outline) camera icon — "vision capability loaded". */
    function CameraIcon() {
      return React.createElement('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true
      },
        React.createElement('path', { d: 'M3.5 8.5h3l1.8-2.6a1 1 0 0 1 .83-.4h5.74a1 1 0 0 1 .83.4L17.5 8.5h3a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1z' }),
        React.createElement('circle', { cx: 12, cy: 13.5, r: 3.4 }),
        React.createElement('path', { d: 'M17.6 9.6h.01' })
      )
    }

    /** Linear spinner ring shown while an image is uploading. */
    function SpinnerIcon() {
      return React.createElement('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        className: 'vb-spin',
        'aria-hidden': true
      },
        React.createElement('path', { d: 'M12 3a9 9 0 1 0 9 9' })
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      // Spinner rotation keyframes (cleaned up with the Client run).
      ctx.effect(() => styles.insert(
        '@keyframes vb-rotate{to{transform:rotate(360deg)}}.vb-spin{animation:vb-rotate .8s linear infinite}'
      ), 'vision-bridge: spinner css')

      slots.inject('conversation.input.left', () => slots.register(
        { name: 'conversation.input.left', id: 'vision-bridge-upload', order: 10 },
        (props) => {
          const input = props && props.input
          const inputActions = props && props.inputActions
          const fileRef = React.useRef(null)
          const [status, setStatus] = React.useState('idle')
          const [busy, setBusy] = React.useState(false)
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
            } catch (error) {
              console.error('vision upload failed', error)
              setStatus('error')
            } finally {
              setBusy(false)
            }
          }
          const icon = busy ? React.createElement(SpinnerIcon, null) : React.createElement(CameraIcon, null)
          const statusText = status === 'uploading' ? '上传中…' : status === 'ok' ? '已上传，回车发送' : status === 'error' ? '上传失败' : null
          const statusColor = status === 'ok' ? '#2e7d32' : status === 'error' ? '#c62828' : '#888'
          return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 4, marginRight: 2 } },
            React.createElement('button', {
              type: 'button',
              title: '识图能力已装载 · 点击上传图片识别',
              disabled: busy,
              onClick: onPick,
              style: { background: 'transparent', border: 'none', cursor: busy ? 'wait' : 'pointer', color: 'inherit', padding: '2px 4px', lineHeight: 1, display: 'inline-flex', alignItems: 'center' }
            }, icon),
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
