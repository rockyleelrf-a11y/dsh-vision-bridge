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
          const dotTitle = vision === null ? '正在检测视觉模型连接…' : (vision.detail || vision.status)
          return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 4, marginRight: 2 } },
            React.createElement('button', {
              type: 'button',
              title: '识图能力已装载 · 点击上传图片识别',
              disabled: busy,
              onClick: onPick,
              style: { background: 'transparent', border: 'none', cursor: busy ? 'wait' : 'pointer', color: 'inherit', opacity: busy ? 0.45 : 1, padding: '2px 4px', lineHeight: 1, display: 'inline-flex', alignItems: 'center' }
            }, React.createElement(CameraIcon, null)),
            React.createElement('span', {
              title: dotTitle,
              onClick: () => refreshStatus(true),
              style: { width: 7, height: 7, borderRadius: '50%', background: dotColor, display: 'inline-block', cursor: 'pointer', flex: 'none' }
            }),
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
