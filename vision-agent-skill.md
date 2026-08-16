# Vision Agent Skill（视觉代理技能）

**让任何纯文本 AI Agent 获得图片识别能力**

这是一个**通用技能文档**，可加载到任何支持自定义指令/技能的 AI Agent 上（如 Anthropic Codex、Trae、WorkBuddy、Claude Code、Cursor 等），让纯文本 Agent 也能识别图片内容、读取图片文字（OCR）、回答关于图片的问题。

---

## 适用平台

| 平台 | 加载方式 |
|---|---|
| **Anthropic Codex CLI** | 配置 `codex.json` 中的 custom tools + 添加系统指令 |
| **Trae / 字节 AI 工具** | 添加到自定义指令 / 技能配置 |
| **WorkBuddy** | 添加到 Agent 技能配置 |
| **Claude Code** | 配置 CLAUDE.md 中的工具声明 |
| **Cursor** | 添加到 .cursorrules 或自定义指令 |
| **任何支持 HTTP 工具的 Agent** | 使用 MCP 协议或自定义 HTTP 工具 |

---

## 原理

纯文本模型无法直接"看见"图片。此技能通过以下方式实现视觉能力：

1. 将图片文件（或粘贴的 base64 数据）发送到**外部视觉 API**（如 OpenAI GPT-4o、通义千问 VL、SenseNova 等）
2. 视觉 API 返回图片的文字描述（包括 OCR 识别结果）
3. Agent 基于返回的描述回答用户的问题

> 注意：此技能需要配置一个可用的视觉 API 密钥。**不会**使用 Agent 当前对话模型来识别图片——而是通过专用的视觉模型 API。

---

## 快速开始

### 1. 选择视觉 API

任选一个你已有 API Key 的服务：

| 服务 | 模型 | API 地址 | 备注 |
|---|---|---|---|
| **OpenAI** | `gpt-4o` / `gpt-4o-mini` | `https://api.openai.com/v1` | 最通用，效果稳定 |
| **阿里通义千问** | `qwen-vl-plus` / `qwen-vl-max` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 中文识别极佳 |
| **智谱 GLM** | `glm-4v-plus` | `https://open.bigmodel.cn/api/paas/v4` | 中文友好 |
| **SenseNova** | `sensenova-6.8-flash-lite` | `https://token.sensenova.cn/v1` | 支持推理 |
| **本地 Ollama** | `llava` / `minicpm-v` | `http://localhost:11434/v1` | 免费，无需联网 |

### 2. 工具脚本

创建一个可执行脚本（如 `vision.sh` 或 `vision.py`），Agent 调用它来识别图片：

```bash
#!/usr/bin/env bash
# vision.sh — 调用视觉 API 识别图片
# 用法: bash vision.sh <image_path> [question]

set -euo pipefail

IMAGE_PATH="$1"
QUESTION="${2:-请用中文详细描述这张图片的内容，包括主要物体、场景、可见文字（OCR）、颜色和细节。}"
API_KEY="${VISION_API_KEY:-}"
API_URL="${VISION_API_URL:-https://api.openai.com/v1/chat/completions}"
MODEL="${VISION_MODEL:-gpt-4o}"

if [ -z "$API_KEY" ]; then
  echo "错误：请设置 VISION_API_KEY 环境变量" >&2
  exit 1
fi

# 将图片转为 base64
BASE64=$(base64 -i "$IMAGE_PATH" 2>/dev/null || base64 < "$IMAGE_PATH")
MIME=$(file --mime-type -b "$IMAGE_PATH" 2>/dev/null || echo "image/png")

# 调用视觉 API
curl -s -m 60 "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d "$(cat <<ENDJSON
{
  "model": "$MODEL",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "$QUESTION"},
        {"type": "image_url", "image_url": {"url": "data:$MIME;base64,$BASE64"}}
      ]
    }
  ],
  "max_tokens": 1500
}
ENDJSON
)" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    content = d['choices'][0]['message']['content']
    print(content)
except Exception as e:
    print(f'视觉 API 调用失败: {e}')
    sys.exit(1)
"
```

保存为 `vision.sh`，执行 `chmod +x vision.sh`。

### 3. 配置环境变量

```bash
export VISION_API_KEY="sk-your-api-key-here"
# 可选：切换 API 地址和模型
# export VISION_API_URL="https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
# export VISION_MODEL="qwen-vl-plus"
```

---

## 技能指令（加载到 Agent 的系统提示中）

将此指令块添加到 Agent 的系统提示 / 自定义指令 / 技能配置中：

```markdown
## Vision Agent Skill（视觉识别技能）

你拥有通过外部视觉 API 识别图片的能力。当用户要求识别图片、读取图片文字（OCR）、描述图片内容或回答关于图片的问题时，使用以下方法：

### 可用工具

- `bash vision.sh <图片路径> [问题]` — 分析指定路径的图片，返回视觉模型对图片内容的文字描述。
  - 图片路径必须是绝对路径或 Agent 工作目录下的相对路径。
  - 问题可选；省略时默认要求详细描述图片内容。

### 核心规则

1. 永远不要描述你没有分析过的图片。先调用工具，然后基于返回的描述回答。
2. 不要猜测、不要根据文件名推断内容、不要编造细节。

### 工作流程

1. 定位图片文件：如果用户给了精确路径，直接使用；如果只描述了，先用文件搜索工具找到它。
2. 调用 `bash vision.sh <路径> [问题]`。
3. 分析返回结果，回答用户的问题。

### 输出格式建议

- 识别：列出主要物体、人物、场景、颜色和细节。
- OCR：逐字转录所有可见文字，保留布局。精确引用原文。
- 描述：整体场景 → 关键主题 → 文字/细节 → 异常点。
- 比较：逐张分析后逐点对比。

### 局限

- 支持的格式：PNG、JPEG、WebP、GIF。
- 识别质量取决于所配置的视觉模型。
- 需要网络连接和有效的 API 密钥。
- 大图片可能被视觉 API 压缩。
```

---

## 不同平台的加载方式

### Anthropic Codex CLI

在 `codex.json` 中配置：

```json
{
  "tools": [
    {
      "name": "vision",
      "description": "Analyze an image file and return a text description of its contents. Supports OCR, object recognition, and scene understanding.",
      "command": "bash vision.sh ${image_path} ${question}"
    }
  ],
  "systemPromptAdditions": "（将上面的技能指令块粘贴到这里）"
}
```

### Cursor

将技能指令块添加到 `.cursorrules` 文件，或粘贴到 Cursor 的 Custom Instructions 中。

### Claude Code

将技能指令块添加到项目根目录的 `CLAUDE.md` 文件中。

### WorkBuddy / 其他通用 Agent

将技能指令块添加到 Agent 的自定义指令/技能配置中，并确保 `vision.sh` 和 API 密钥在 Agent 的运行环境中可用。

---

## 验证安装

```bash
# 测试：识别一张图片
bash vision.sh /path/to/test.png "这张图里有什么？"
```

如果返回了图片内容的文字描述，说明技能配置成功。

---

## 安全注意事项

- API 密钥通过 `VISION_API_KEY` 环境变量传递，不要硬编码在脚本中
- 图片文件会经过 base64 编码传输到视觉 API，确保图片不包含敏感信息
- 视觉 API 调用会产生费用，具体取决于所选的 API 定价

---

## 许可证

MIT