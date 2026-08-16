import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'vision-bridge'

/** Services required by the vision bridge host half. */
const inject = [
  'tools',
  'fs',
  'attachments',
  'llm',
  'sandboxPolicy',
  'webServer',
]

const EXT_MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
const MAX_BODY_BYTES = 8 * 1024 * 1024
const DEFAULT_QUESTION = '请用中文详细描述这张图片的内容：主要物体、场景、可见文字（OCR）、颜色和细节。'

function base64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function extOf(path) {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot >= 0 ? lower.slice(dot) : ''
}

function imageBlockFor(ref) {
  return {
    type: 'image',
    attachment: {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name })
    }
  }
}

/**
 * Discover every model route that declares image input. Any provider whose
 * models carry `inputModalities` containing "image" qualifies — sensenova is
 * only the route configured in this deployment's settings; an OpenAI-compatible
 * vision endpoint declared the same way is picked up automatically.
 * Cached until `llm/adapters-updated` fires.
 */
let visionRoutesPromise = null

function discoverVisionRoutes(ctx) {
  if (visionRoutesPromise !== null) return visionRoutesPromise
  visionRoutesPromise = (async () => {
    const llm = ctx.get('llm')
    if (!llm) return []
    const routes = []
    for (const info of llm.listProviders()) {
      try {
        const models = await llm.listModels(info.id)
        for (const model of models) {
          if (model.inputModalities && model.inputModalities.includes('image')) {
            routes.push({ provider: info.id, model: model.id })
          }
        }
      } catch (error) {
        // a provider that fails to list its models is skipped, not fatal
      }
    }
    return routes
  })()
  return visionRoutesPromise
}

function invalidateVisionRoutes() {
  visionRoutesPromise = null
}

/**
 * Call the first available vision model for one image block; falls through the
 * discovered routes in provider order.
 * @returns {{ answer: string, provider: string, model: string }}
 */
async function callVisionModel(ctx, imageBlock, question, signal) {
  const llm = ctx.get('llm')
  if (!llm) throw new Error('未挂载 llm 服务')
  const routes = await discoverVisionRoutes(ctx)
  if (routes.length === 0) throw new Error('未配置可用的视觉模型（请在设置中配置一个声明了图片输入的模型，例如 llm-pi-ai 的 sensenova 视觉模型）')
  let lastError = null
  for (const route of routes) {
    try {
      const chunks = llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: question }, imageBlock] }],
        maxTokens: 1500,
        signal
      })
      let answer = ''
      for await (const chunk of chunks) {
        if (chunk.type === 'text-delta') answer += chunk.text
        else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          const failure = chunk.reason.failure
          lastError = new Error(failure && failure.message ? failure.message : ('视觉模型调用失败: ' + chunk.reason.kind))
          answer = ''
          break
        }
      }
      answer = answer.trim()
      if (answer) return { answer, provider: route.provider, model: route.model }
      if (lastError === null) lastError = new Error('视觉模型没有返回内容')
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw lastError || new Error('视觉模型调用失败')
}

async function runVision(ctx, data, mediaType, imageName, question, signal) {
  const attachments = ctx.get('attachments')
  if (!attachments) throw new Error('未挂载附件服务，无法分析图片')
  let ref
  try {
    ref = await attachments.saveImage({ data, mediaType, name: imageName })
  } catch (error) {
    throw new Error('图片校验失败: ' + (error && error.message ? error.message : String(error)))
  }
  const result = await callVisionModel(ctx, imageBlockFor(ref), question, signal)
  return { ref, ...result }
}

/** Describe an already-durable attachment via the vision model. */
async function describeAttachment(ctx, attachment, signal) {
  const attachments = ctx.get('attachments')
  if (!attachments) throw new Error('未挂载附件服务')
  const stored = await attachments.readImage(attachment, signal)
  const ref = {
    attachmentId: stored.ref.attachmentId,
    mediaType: stored.ref.mediaType,
    bytes: stored.ref.bytes,
    width: stored.ref.width,
    height: stored.ref.height,
    ...(stored.ref.name === undefined ? {} : { name: stored.ref.name })
  }
  const { answer } = await callVisionModel(ctx, imageBlockFor(ref), DEFAULT_QUESTION, signal)
  return answer
}

/**
 * Replace image content blocks in one model-request message list with text
 * descriptions. This runs at the `llm/stream` layer — AFTER the conversation
 * log and the GUI already received the original image message — so the chat
 * keeps showing the pasted image while the text-only main model reads the
 * vision-model description. Descriptions are cached per attachment id so
 * historical image messages are converted once, not on every request.
 * @returns the converted message list, or null when nothing contained images.
 */
async function convertRequestImages(ctx, messages, signal, cache) {
  let changed = false
  const converted = []
  for (const message of messages) {
    if (!message || !Array.isArray(message.content) || !message.content.some((block) => block && block.type === 'image')) {
      converted.push(message)
      continue
    }
    const newContent = []
    for (const block of message.content) {
      if (block && block.type === 'image') {
        const attachment = block.attachment
        const key = attachment && attachment.attachmentId ? String(attachment.attachmentId) : null
        let description = key !== null ? cache.get(key) : undefined
        if (description === undefined) {
          try {
            description = await describeAttachment(ctx, attachment, signal)
          } catch (error) {
            description = '（图片识别失败：' + (error && error.message ? error.message : String(error)) + '）'
          }
          if (key !== null) cache.set(key, description)
        }
        const meta = attachment && attachment.mediaType ? ' (' + attachment.mediaType + ')' : ''
        newContent.push({ type: 'text', text: '[用户粘贴的图片' + meta + '：' + description + ']' })
        changed = true
      } else {
        newContent.push(block)
      }
    }
    converted.push({ ...message, content: newContent })
  }
  return changed ? converted : null
}

async function handleUpload(ctx, body) {
  const nameIn = body && typeof body.name === 'string' ? body.name : 'image.png'
  const dataUrl = body && typeof body.dataUrl === 'string' ? body.dataUrl : ''
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!m) throw new Error('不支持的图片格式：仅支持 PNG/JPEG/WebP/GIF')
  const mediaType = m[1]
  const data = base64ToBytes(m[2])
  const attachments = ctx.get('attachments')
  const fsSvc = ctx.get('fs')
  if (!attachments) throw new Error('未挂载附件服务')
  if (!fsSvc) throw new Error('未挂载文件系统服务')
  if (data.length > attachments.imageLimits.maxImageBytes) throw new Error('图片过大（' + data.length + ' 字节，上限 ' + attachments.imageLimits.maxImageBytes + ' 字节）')
  try {
    await attachments.validateImage({ data, mediaType })
  } catch (error) {
    throw new Error('图片校验失败：' + (error && error.message ? error.message : String(error)))
  }
  const sp = ctx.get('sandboxPolicy')
  const cwd = sp && sp.workspaceRoot ? sp.workspaceRoot : undefined
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  const safeName = (nameIn.replace(/[^\w.\-]/g, '_') || 'image').slice(0, 60)
  const rel = '.dsh/vision_' + stamp + '_' + safeName + '.b64'
  const target = await fsSvc.resolve(rel, cwd ? { cwd } : undefined)
  await fsSvc.writeText(target, JSON.stringify({ mediaType, base64: m[2], name: safeName }))
  return { path: fsSvc.processPath(target), mediaType, bytes: data.length, name: safeName }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(new Error('无效的 JSON 请求体'))
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

function apply(ctx) {
  // Per-attachment description cache shared by the tool and the stream layer.
  const descriptionCache = new Map()

  const tool = defineTool({
    name: 'vision_analyze',
    description: '分析一张图片（PNG/JPEG/WebP/GIF）并返回视觉模型对图片内容的文字描述。当前会话主模型是纯文本模型，无法直接看见图片，必须调用本工具才能识别图片内容、读取图片中的文字（OCR）或回答关于图片的问题。',
    parameters: {
      image_path: { type: 'string', required: true, description: '图片文件路径，由文件系统后端解析。支持 .png/.jpg/.jpeg/.webp/.gif 图片文件，也支持 vision 上传按钮生成的 .b64 收据文件。' },
      question: { type: 'string', description: '关于这张图片的提问（可选）；省略时默认要求视觉模型详细描述图片内容。' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          question: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          answer: { type: 'string', required: true }
        }
      },
      render: (args, value) => [{
        type: 'text',
        text: '[vision_analyze] ' + value.mediaType + ' ' + value.width + 'x' + value.height + '（' + value.model + '）\n' + value.answer
      }]
    },
    timeoutMs: 180000,
    async execute(args, exec) {
      const imagePath = typeof args.image_path === 'string' ? args.image_path.trim() : ''
      if (!imagePath) throw new Error('image_path 不能为空')
      const question = typeof args.question === 'string' && args.question.trim() ? args.question.trim() : DEFAULT_QUESTION
      const fsSvc = ctx.get('fs')
      if (!fsSvc) throw new Error('未挂载文件系统服务')
      const sp = ctx.get('sandboxPolicy')
      const cwd = sp && sp.workspaceRoot ? sp.workspaceRoot : undefined
      const target = await fsSvc.resolve(imagePath, cwd ? { cwd } : undefined)
      const ext = extOf(imagePath)
      let data, mediaType, imageName
      if (ext === '.b64') {
        const text = await fsSvc.readText(target, exec.signal)
        let parsed
        try { parsed = JSON.parse(text) } catch (e) { throw new Error('无效的 .b64 收据文件') }
        if (!parsed || typeof parsed.base64 !== 'string' || typeof parsed.mediaType !== 'string') throw new Error('无效的 .b64 收据文件')
        mediaType = parsed.mediaType
        data = base64ToBytes(parsed.base64)
        imageName = typeof parsed.name === 'string' && parsed.name ? parsed.name : 'image'
      } else {
        mediaType = EXT_MEDIA[ext]
        if (!mediaType) throw new Error('仅支持 PNG/JPEG/WebP/GIF 图片（或 .b64 收据），收到扩展名: ' + (ext || '(无)'))
        const attachments = ctx.get('attachments')
        if (!attachments) throw new Error('未挂载附件服务')
        if (!attachments.imageLimits.mediaTypes.includes(mediaType)) throw new Error(mediaType + ' 不被此部署接受')
        const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
        data = await fsSvc.readBytes(target, exec.signal, byteCap)
        imageName = imagePath.split('/').pop() || 'image'
      }
      const { ref, answer, provider, model } = await runVision(ctx, data, mediaType, imageName, question, exec.signal)
      return {
        path: imagePath,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        question,
        provider,
        model,
        answer
      }
    }
  })
  ctx.tools.register(tool)

  // Paste pipeline: convert image blocks to vision-model text descriptions at
  // the LAST layer (llm/stream), right before the request reaches the adapter.
  // The conversation log and GUI keep the original image message; only the
  // model request carries the text description. Requests to models that
  // themselves declare image input are left untouched.
  ctx.on('llm/stream', async function (options, next) {
    try {
      const messages = options && Array.isArray(options.messages) ? options.messages : null
      if (!messages || messages.length === 0) return next()
      const hasImage = messages.some((message) => message && Array.isArray(message.content) && message.content.some((block) => block && block.type === 'image'))
      if (!hasImage) return next()
      const routes = await discoverVisionRoutes(ctx)
      if (routes.some((route) => route.provider === options.provider && route.model === options.model)) return next()
      const converted = await convertRequestImages(ctx, messages, options.signal, descriptionCache)
      if (converted === null) return next()
      // next() cannot carry a replaced payload (cordis waterfall dispatches the
      // original arguments), so short-circuit through the runtime with the
      // converted request; the re-entered waterfall sees no images and calls
      // next() normally, reaching the adapter.
      return this.streamWithRegistration({ ...options, messages: converted })
    } catch (error) {
      console.error('[vision-bridge] llm/stream conversion failed', error)
      return next()
    }
  })

  // Refresh the vision-route discovery when the provider topology changes.
  ctx.on('llm/adapters-updated', () => {
    invalidateVisionRoutes()
    descriptionCache.clear()
  })

  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/vision-upload',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const result = await handleUpload(ctx, body)
          writeJson(res, 200, result)
        } catch (error) {
          writeJson(res, 400, { error: error && error.message ? error.message : String(error) })
        }
      }
    }), 'vision-bridge: /vision-upload route')
  }
}

export { apply, inject, name }
