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

// Vision-call deadlines and route health. External vision endpoints can be
// slow (SenseNova routinely takes 30s+ even on text) or hang entirely; without
// a deadline the conversion inside `llm/stream` blocks the whole user turn and
// whatever later tears the connection down surfaces as a cryptic
// "Request aborted". Each route attempt gets its own timeout; a route that
// just failed is skipped during its cooldown so repeat pastes fail fast with a
// readable message instead of hanging again. Local Ollama runs on CPU here and
// needs a much longer budget (image encoding alone can take ~80s), so its
// attempts get their own relaxed deadline instead of sharing the cloud one.
const VISION_ROUTE_TIMEOUT_MS = 90 * 1000
const OLLAMA_ROUTE_TIMEOUT_MS = 180 * 1000
const VISION_ROUTE_COOLDOWN_MS = 5 * 60 * 1000
const VISION_MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000 // 最大冷却2小时
const VISION_MAX_TOKENS = 4096
const VISION_ROUTE_STATE = new Map() // 'provider/model' -> { lastFailureAt, failures, cooldownMs }

// 用户选择的视觉模型（持久化到文件，重启/切换对话后保留）
let userPreferredVisionRoute = null // { provider, model }
const PREFS_FILE = '.vision-bridge-prefs.json'
let _prefsCtx = null // cache ctx for filesystem access

/** 加载持久化的用户偏好 */
async function loadPreferences(ctx) {
  _prefsCtx = ctx
  try {
    const fsSvc = ctx.get('fs')
    if (!fsSvc) return
    const sp = ctx.get('sandboxPolicy')
    const cwd = sp && sp.workspaceRoot ? sp.workspaceRoot : undefined
    const target = await fsSvc.resolve(PREFS_FILE, cwd ? { cwd } : undefined)
    const text = await fsSvc.readText(target)
    const data = JSON.parse(text)
    if (data && typeof data.provider === 'string' && typeof data.model === 'string') {
      userPreferredVisionRoute = { provider: data.provider, model: data.model }
    }
  } catch (e) {
    // file not found or parse error — first run, no preference yet
  }
}

/** 保存用户偏好到文件 */
async function savePreferences() {
  if (!_prefsCtx) return
  try {
    const fsSvc = _prefsCtx.get('fs')
    if (!fsSvc) return
    const sp = _prefsCtx.get('sandboxPolicy')
    const cwd = sp && sp.workspaceRoot ? sp.workspaceRoot : undefined
    const target = await fsSvc.resolve(PREFS_FILE, cwd ? { cwd } : undefined)
    const data = userPreferredVisionRoute
      ? { provider: userPreferredVisionRoute.provider, model: userPreferredVisionRoute.model }
      : null
    await fsSvc.writeText(target, JSON.stringify(data))
  } catch (e) {
    // best-effort: ignore write errors
  }
}

/** 设置用户偏好的视觉模型（同步内存 + 异步持久化） */
function setUserPreferredVisionRoute(provider, model) {
  userPreferredVisionRoute = provider && model ? { provider, model } : null
  savePreferences()
}

/** 获取用户偏好的视觉模型 */
function getUserPreferredVisionRoute() {
  return userPreferredVisionRoute
}

/** Per-route deadline: local Ollama gets the relaxed budget. */
function routeTimeoutMs(route) {
  return route.provider === 'ollama' ? OLLAMA_ROUTE_TIMEOUT_MS : VISION_ROUTE_TIMEOUT_MS
}

function routeKeyOf(route) {
  return route.provider + '/' + route.model
}

function routeInCooldown(route) {
  const state = VISION_ROUTE_STATE.get(routeKeyOf(route))
  if (!state) return false
  const cooldownMs = state.cooldownMs || VISION_ROUTE_COOLDOWN_MS
  return Date.now() - state.lastFailureAt < cooldownMs
}

/** 指数退避：连续失败次数越多，冷却时间越长（5min→15min→45min→2h封顶） */
function markRouteFailure(route) {
  const key = routeKeyOf(route)
  const existing = VISION_ROUTE_STATE.get(key)
  const failures = existing ? (existing.failures || 0) + 1 : 1
  const cooldownMs = Math.min(VISION_ROUTE_COOLDOWN_MS * Math.pow(3, failures - 1), VISION_MAX_COOLDOWN_MS)
  VISION_ROUTE_STATE.set(key, { lastFailureAt: Date.now(), failures, cooldownMs })
}

function markRouteSuccess(route) {
  VISION_ROUTE_STATE.delete(routeKeyOf(route))
}

/** Fuse a caller signal with a hard deadline; `signal` may be undefined. */
function fuseSignal(signal, timeoutMs) {
  const deadline = AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return deadline
  return AbortSignal.any([signal, deadline])
}

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
      // Skip providers that are known to only serve text models — the
      // llm-deepseek patch (step 3) declares image input on the deepseek
      // route to make the admission gates pass, but deepseek models are
      // text-only and cannot actually process images.
      if (info.id === 'deepseek-official') continue
      const knownTextModels = ['deepseek-v4-flash', 'deepseek-v3', 'deepseek-r1', 'deepseek-chat']
      try {
        const models = await llm.listModels(info.id)
        for (const model of models) {
          if (!model.inputModalities || !model.inputModalities.includes('image')) continue
          if (knownTextModels.includes(model.id)) continue
          routes.push({ provider: info.id, model: model.id })
        }
      } catch (error) {
        // a provider that fails to list its models is skipped, not fatal
      }
    }
    // Cloud routes first (fast), local Ollama last (slow CPU fallback).
    // This prevents a slow Ollama load from blocking the user for 80+ seconds
    // when a fast cloud route is available.
    return routes.sort((a, b) => (a.provider === 'ollama' ? 1 : 0) - (b.provider === 'ollama' ? 1 : 0))
  })()
  return visionRoutesPromise
}

// ---------------------------------------------------------------------------
// Ollama: free, open-source local vision models (LLaVA / MiniCPM-V / Qwen2.5-VL…).
// The plugin auto-detects a running Ollama (http://127.0.0.1:11434) and routes
// image calls to its vision models with no API key, no cost, data stays local.
// ---------------------------------------------------------------------------
const OLLAMA_BASE = 'http://127.0.0.1:11434'

/** List Ollama vision models (capabilities include 'vision'); [] when offline. */
async function ollamaVisionModels() {
  try {
    const res = await fetch(OLLAMA_BASE + '/api/tags', { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return []
    const data = await res.json()
    const list = Array.isArray(data.models) ? data.models : []
    return list
      .filter((m) => Array.isArray(m.capabilities) && m.capabilities.includes('vision'))
      .map((m) => ({ id: m.name || m.model, name: m.name || m.model }))
  } catch (error) {
    return []
  }
}

/** Convert harness content blocks into Ollama OpenAI-compatible content parts. */
async function ollamaContent(ctx, blocks, signal) {
  const parts = []
  for (const block of blocks) {
    if (!block) continue
    if (block.type === 'text') {
      if (block.text) parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const attachments = ctx.get('attachments')
      if (!attachments) continue
      const stored = await attachments.readImage(block.attachment, signal)
      parts.push({
        type: 'image_url',
        image_url: { url: 'data:' + stored.ref.mediaType + ';base64,' + Buffer.from(stored.data).toString('base64') }
      })
    }
  }
  return parts
}

/** Minimal LlmAdapter for the local Ollama route (registered in apply). */
function makeOllamaAdapter(ctx) {
  return {
    providerInfo(provider) {
      return { id: 'ollama', name: 'Ollama 本地（免费开源）' }
    },
    providerRetryPolicy() {
      return undefined
    },
    async listModels(provider) {
      const models = await ollamaVisionModels()
      return models.map((m) => ({ provider, id: m.id, name: m.name, inputModalities: ['text', 'image'] }))
    },
    async resolveModel(provider, model, _signal) {
      return {
        provider,
        id: model,
        name: model,
        inputModalities: ['text', 'image'],
        context: { contextWindow: 131072 },
        defaultMaxTokens: 4096
      }
    },
    async *stream(options) {
      try {
        const messages = []
        if (options.system) {
          messages.push({ role: 'system', content: [{ type: 'text', text: options.system }] })
        }
        for (const message of options.messages) {
          const role = message.role === 'assistant' ? 'assistant' : 'user'
          messages.push({ role, content: await ollamaContent(ctx, message.content, options.signal) })
        }
        const body = {
          model: options.model,
          messages,
          ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
          stream: true
        }
        const res = await fetch(OLLAMA_BASE + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: options.signal
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error('Ollama HTTP ' + res.status + ': ' + text.slice(0, 200))
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let fullText = ''
        let doneSignal = false
        yield { type: 'block-start', index: 0, blockType: 'text' }
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let nl
          while (!doneSignal && (nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') {
              doneSignal = true
              break
            }
            try {
              const json = JSON.parse(payload)
              const delta = json.choices && json.choices[0] && json.choices[0].delta
              const piece = delta && typeof delta.content === 'string' ? delta.content : ''
              if (piece) {
                fullText += piece
                yield { type: 'text-delta', index: 0, text: piece }
              }
            } catch (e) {
              // skip malformed SSE frames
            }
          }
          if (doneSignal) break
        }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: fullText } }
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } catch (error) {
        const aborted = options.signal && options.signal.aborted
        yield {
          type: 'finish',
          reason: aborted
            ? { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } }
            : { kind: 'error', failure: { message: errText(error), code: 'OLLAMA_ERROR' } }
        }
      }
    }
  }
}

function registerOllamaAdapter(ctx) {
  const llm = ctx.get('llm')
  if (!llm) return
  try {
    llm.registerAdapter(['ollama'], makeOllamaAdapter(ctx))
  } catch (error) {
    console.error('[vision-bridge] ollama adapter registration failed', errText(error))
  }
}

function invalidateVisionRoutes() {
  visionRoutesPromise = null
}

/** Known vision-capable model IDs (prefixes) that should declare image input. */
const KNOWN_VISION_MODEL_PREFIXES = [
  'sensenova-6.7', 'sensenova-6.8', 'sensenova-6.9', 'sensenova-7', 'sensenova-nova',
  'glm-4v', 'glm-5v', 'glm-5.2v',
  'qwen-vl', 'qwen2-vl', 'qwen2.5-vl',
  'gpt-4o', 'gpt-4-vision',
  'llava', 'minicpm-v', 'bakllava', 'llama3.2-vision',
  'internvl', 'internlm-xcomposer',
]
function isVisionModelId(id) {
  if (!id || typeof id !== 'string') return false
  const lower = id.toLowerCase()
  return KNOWN_VISION_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/**
 * Scan the user's settings.yaml for llm-pi-ai providers whose models are
 * known vision models but lack the `input: [text, image]` declaration, and
 * automatically add it.  This ensures the plugin discovers them without
 * requiring the user to manually edit settings.
 */
async function autoConfigureVisionModels(ctx) {
  try {
    const settings = ctx.get('settings')
    if (!settings) return
    const piConfig = settings.get('llm-pi-ai')
    if (!piConfig || typeof piConfig !== 'object') return
    const providers = piConfig.providers
    if (!providers || typeof providers !== 'object') return
    const ops = []
    for (const [provider, profile] of Object.entries(providers)) {
      if (!profile || typeof profile !== 'object') continue
      const models = profile.models
      if (!Array.isArray(models)) continue
      for (let i = 0; i < models.length; i++) {
        const model = models[i]
        if (!model || typeof model !== 'object') continue
        if (model.input) continue // already declared
        if (!isVisionModelId(model.id)) continue
        ops.push({
          op: 'set',
          path: ['providers', provider, 'models', String(i), 'input'],
          value: ['text', 'image']
        })
      }
    }
    if (ops.length === 0) return
    await settings.mutate('llm-pi-ai', ops)
    invalidateVisionRoutes()
    console.log('[vision-bridge] auto-configured %d vision model(s) in settings.yaml', ops.length)
  } catch (error) {
    console.error('[vision-bridge] auto-configure vision models failed', errText(error))
  }
}

/** Normalize an unknown thrown value to a readable string (avoid [object Object]). */
function errText(error) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

/**
 * Call vision models for one image block, falling through the discovered
 * routes in provider order. Every route attempt is bounded by
 * VISION_ROUTE_TIMEOUT_MS and a route that just failed is skipped during its
 * cooldown, so a hung or flaky endpoint cannot block the user's turn forever
 * and repeat pastes fail fast with a readable message.
 * 
 * 用户选择的模型优先使用。如果用户指定了模型，直接使用，不走自动路由。
 * 如果指定模型不可用，再 fallback 到自动路由。
 * @returns {{ answer: string, provider: string, model: string }}
 */
async function callVisionModel(ctx, imageBlock, question, signal) {
  const llm = ctx.get('llm')
  if (!llm) throw new Error('未挂载 llm 服务')
  const routes = await discoverVisionRoutes(ctx)
  if (routes.length === 0) throw new Error('未配置可用的视觉模型（请在设置中配置一个声明了图片输入的模型，例如 llm-pi-ai 的 sensenova 视觉模型）')

  // 优先使用用户选择的模型
  const preferred = getUserPreferredVisionRoute()
  if (preferred) {
    const preferredRoute = routes.find((r) => r.provider === preferred.provider && r.model === preferred.model)
    if (preferredRoute && !routeInCooldown(preferredRoute)) {
      try {
        const routeSignal = fuseSignal(signal, routeTimeoutMs(preferredRoute))
        const chunks = llm.stream({
          provider: preferredRoute.provider,
          model: preferredRoute.model,
          messages: [{ role: 'user', content: [{ type: 'text', text: question }, imageBlock] }],
          maxTokens: VISION_MAX_TOKENS,
          signal: routeSignal
        })
        let answer = ''
        for await (const chunk of chunks) {
          if (chunk.type === 'text-delta') answer += chunk.text
          else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
            const failure = chunk.reason.failure
            throw new Error(failure && failure.message ? failure.message : ('视觉模型调用失败: ' + chunk.reason.kind))
          }
        }
        answer = answer.trim()
        if (answer) {
          markRouteSuccess(preferredRoute)
          return { answer, provider: preferredRoute.provider, model: preferredRoute.model }
        }
        // 用户选择的模型无响应，fallback 到自动路由
      } catch (error) {
        // 用户选择的模型失败，fallback 到自动路由
        console.error('[vision-bridge] preferred model failed, fallback to auto routes', error)
      }
    }
  }

  // 自动路由 fallback
  const attemptable = routes.filter((route) => !routeInCooldown(route))
  if (attemptable.length === 0) {
    const keys = routes.map(routeKeyOf).join('、')
    throw new Error('视觉模型暂时不可用（' + keys + ' 最近调用失败，冷却中，请稍后再试）')
  }
  let lastError = null
  for (const route of attemptable) {
    const routeSignal = fuseSignal(signal, routeTimeoutMs(route))
    const timedOut = () => routeSignal.aborted && !(signal && signal.aborted)
    try {
      const chunks = llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: question }, imageBlock] }],
        maxTokens: VISION_MAX_TOKENS,
        signal: routeSignal
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
      if (answer) {
        markRouteSuccess(route)
        return { answer, provider: route.provider, model: route.model }
      }
      lastError = timedOut()
        ? new Error('视觉模型响应超时（' + Math.round(routeTimeoutMs(route) / 1000) + ' 秒无输出）')
        : lastError === null ? new Error('视觉模型没有返回内容') : lastError
    } catch (error) {
      lastError = timedOut()
        ? new Error('视觉模型响应超时（' + Math.round(routeTimeoutMs(route) / 1000) + ' 秒无输出）')
        : (error instanceof Error ? error : new Error(String(error)))
    }
    // A caller-cancelled attempt is not a route failure: do not start cooldown.
    if (!(signal && signal.aborted)) markRouteFailure(route)
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
    // First pass: collect all image blocks and resolve descriptions in parallel.
    const imageBlocks = message.content.filter((b) => b && b.type === 'image')
    const descs = await Promise.all(imageBlocks.map(async (block) => {
      const attachment = block.attachment
      const key = attachment && attachment.attachmentId ? String(attachment.attachmentId) : null
      if (key !== null && cache.has(key)) return cache.get(key)
      try {
        const desc = await describeAttachment(ctx, attachment, signal)
        if (key !== null) cache.set(key, desc)
        return desc
      } catch (error) {
        // Deliberately NOT cached: a transient failure (timeout, endpoint blip)
        // must not poison this attachment for the rest of the session. The next
        // request retries the vision call.
        return '（图片识别失败：' + errText(error) + '）'
      }
    }))
    // Second pass: rebuild content with descriptions in place.
    let imgIdx = 0
    const newContent = []
    for (const block of message.content) {
      if (block && block.type === 'image') {
        const attachment = block.attachment
        const meta = attachment && attachment.mediaType ? ' (' + attachment.mediaType + ')' : ''
        newContent.push({ type: 'text', text: '[用户粘贴的图片' + meta + '：' + descs[imgIdx++] + ']' })
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
  // Register the local Ollama route so free open-source vision models are
  // discovered automatically alongside paid providers (idempotent per process).
  registerOllamaAdapter(ctx)

  // Load persisted user vision model preference from disk (best-effort, non-blocking).
  loadPreferences(ctx).catch(() => {})

  // Auto-configure vision models in settings.yaml: if the user has configured
  // models from a known vision-capable provider (e.g. sensenova) but forgot to
  // declare `input: [text, image]`, the plugin automatically adds it so the
  // models are discovered as vision routes without manual editing.
  autoConfigureVisionModels(ctx)

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
        if (!Object.values(EXT_MEDIA).includes(parsed.mediaType)) throw new Error('无效的 .b64 收据文件（不支持的 mediaType: ' + parsed.mediaType + '）')
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

  // Paste pipeline: rewrite image blocks into vision-model text descriptions at
  // the LAST layer (llm/stream), just before the request reaches the adapter.
  // The conversation log and GUI keep the original image message; only the
  // model request carries the text description. Requests to models that
  // themselves declare image input are passed through unchanged.
  //
  // MUST return an async-iterable (async generator), never a Promise. The
  // `llm/stream` waterfall (cordis) forwards the listener's return value as the
  // stream; an `async function` wrapped the async generator in a Promise and
  // the upstream `yield* ctx.llm.stream(...)` threw
  // "yield* (intermediate value) is not async iterable" — every request failed.
  ctx.on('llm/stream', function (options, next) {
    const messages = options && Array.isArray(options.messages) ? options.messages : null
    if (!messages || messages.length === 0) return next()
    const hasImage = messages.some((message) => message && Array.isArray(message.content) && message.content.some((block) => block && block.type === 'image'))
    if (!hasImage) return next()
    return (async function* () {
      try {
        const routes = await discoverVisionRoutes(ctx)
        if (routes.some((route) => route.provider === options.provider && route.model === options.model)) {
          yield* next()
          return
        }
        const converted = await convertRequestImages(ctx, messages, options.signal, descriptionCache)
        if (converted === null) {
          yield* next()
          return
        }
        // Re-enter the runtime stream with the image-free request. We cannot
        // mutate `options` (the waterfall dispatches the original args) and the
        // old `this.streamWithRegistration` call was wrong (that method lives on
        // the LlmRuntime instance, not the ctx listener `this`). Call the llm
        // service directly instead. On re-entry the messages carry no images, so
        // this listener short-circuits via `return next()` above and the request
        // reaches the text-only adapter unchanged.
        const llm = ctx.get('llm')
        yield* llm.stream({ ...options, messages: converted })
      } catch (error) {
        console.error('[vision-bridge] llm/stream conversion failed', error)
        yield* next()
      }
    })()
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

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/vision-status',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '', 'http://localhost')
          // refresh=1 forces a fresh route discovery (the client uses it after
          // an upload or a model pick, when settings may have changed).
          const force = url.searchParams.get('refresh') === '1'
          if (force) invalidateVisionRoutes()
          const preferProvider = url.searchParams.get('provider')
          const preferModel = url.searchParams.get('model')
          let routes = await discoverVisionRoutes(ctx)
          // If the client specified a preferred model, try to match it.
          if (preferProvider && preferModel) {
            const preferred = routes.find((r) => r.provider === preferProvider && r.model === preferModel)
            if (preferred) {
              // Move the preferred route to the front.
              routes = [preferred, ...routes.filter((r) => r !== preferred)]
            }
          }
          if (routes.length === 0) {
            writeJson(res, 200, { status: 'error', detail: '未配置可用的视觉模型', provider: null, model: null, cooldown: false })
          } else {
            // Prefer routes that are not in failure cooldown; a route that
            // recently failed is reported so the client can show "暂时不可用".
            const usable = routes.filter((route) => !routeInCooldown(route))
            if (usable.length === 0) {
              const keys = routes.map(routeKeyOf).join('、')
              writeJson(res, 200, { status: 'error', detail: '视觉模型暂时不可用（' + keys + ' 最近调用失败，冷却中）', provider: null, model: null, cooldown: true })
            } else {
              const route = usable[0]
              writeJson(res, 200, { status: 'ok', detail: '视觉模型已连接（' + route.model + '）', provider: route.provider, model: route.model, cooldown: false })
            }
          }
        } catch (error) {
          writeJson(res, 200, { status: 'error', detail: (error && error.message ? error.message : String(error)) })
        }
      }
    }), 'vision-bridge: /vision-status route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/vision-models',
      handler: async (req, res) => {
        try {
          const routes = await discoverVisionRoutes(ctx)
          const models = routes.map((r) => ({ provider: r.provider, model: r.model, healthy: !routeInCooldown(r) }))
          // The active model is the first route not in failure cooldown.
          const usable = routes.filter((r) => !routeInCooldown(r))
          const active = usable.length > 0 ? { provider: usable[0].provider, model: usable[0].model } : null
          writeJson(res, 200, { models, active })
        } catch (error) {
          writeJson(res, 200, { models: [], active: null })
        }
      }
    }), 'vision-bridge: /vision-models route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/vision-select',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            writeJson(res, 405, { error: '需要 POST 方法' })
            return
          }
          const body = await readJsonBody(req)
          const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
          const model = typeof body.model === 'string' ? body.model.trim() : ''
          setUserPreferredVisionRoute(provider || null, model || null)
          const routes = await discoverVisionRoutes(ctx)
          const selected = provider && model ? routes.find((r) => r.provider === provider && r.model === model) : null
          writeJson(res, 200, { 
            ok: true, 
            selected: selected ? { provider: selected.provider, model: selected.model } : null,
            message: selected ? '已切换到 ' + model : (provider ? '模型不可用' : '已清除选择，恢复自动路由')
          })
        } catch (error) {
          writeJson(res, 400, { error: error && error.message ? error.message : String(error) })
        }
      }
    }), 'vision-bridge: /vision-select route')
  }
}

export { apply, inject, name }
