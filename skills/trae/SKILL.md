---
name: 图片识别
description: 识别图片内容、读取图片文字（OCR）、回答关于图片的问题。通过外部视觉 API 让 AI 也能"看见"图片。
version: 1.0.0
author: rockyleelrf-a11y
---

# 图片识别技能（Vision Bridge）

此技能赋予你通过外部视觉 API 识别图片的能力。当用户要求识别图片、读取图片文字（OCR）、描述图片内容或回答关于图片的问题时，使用本技能。

## 可用的工具脚本

本技能包含 `vision.sh` 脚本，可调用外部视觉 API 分析图片：

```bash
bash vision.sh <图片路径> [问题]
```

- 图片路径：支持 PNG、JPEG、WebP、GIF 格式
- 问题：可选，省略时默认要求详细描述图片内容

## 使用前提

在使用本技能前，需要确保：

1. 环境变量 `VISION_API_KEY` 已设置（视觉 API 的密钥）
2. 可选：`VISION_API_URL` 和 `VISION_MODEL` 可切换不同的视觉服务

### 默认配置

- API：`https://api.openai.com/v1/chat/completions`
- 模型：`gpt-4o`
- 密钥：从 `VISION_API_KEY` 环境变量读取

### 切换其他视觉服务

设置环境变量即可切换，例如使用阿里通义千问：

```bash
export VISION_API_URL="https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
export VISION_MODEL="qwen-vl-plus"
```

## 核心规则

1. **永远不要描述你没有分析过的图片。** 先调用 `bash vision.sh` 工具，然后基于返回的描述回答。
2. 不要猜测、不要根据文件名推断内容、不要编造细节。

## 工作流程

1. **定位图片文件。** 如果用户给了精确路径，直接使用；如果只描述了位置，先用文件搜索工具找到它。
2. **调用 `bash vision.sh <路径> [问题]`**。
3. **分析返回结果，** 然后直接回答用户的问题。

### 输出格式建议

- **识别**：列出主要物体、人物、场景、颜色和显著细节。
- **OCR**：忠实转录所有可见文字，保留布局和换行。精确引用原文。
- **描述**：整体场景 → 关键主题 → 文字/细节 → 异常点。
- **比较**：逐张分析后逐点对比。

## 常见问题

**Q：没有配置 API 密钥怎么办？**
A：提示用户设置 `VISION_API_KEY` 环境变量，或在支持的环境配置文件中添加。

**Q：图片识别结果不准确？**
A：可以建议用户换用更强大的视觉模型，或针对图片提出更具体的问题。

**Q：支持哪些图片格式？**
A：PNG、JPEG、WebP、GIF。不支持 SVG、BMP 等其他格式。

## 局限

- 支持的格式：PNG、JPEG、WebP、GIF
- 识别质量取决于所配置的视觉模型能力
- 需要网络连接和有效的 API 密钥
- 大图片可能被视觉 API 压缩或限制

## 隐私说明

图片文件会经过 base64 编码传输到所配置的视觉 API 服务。请确保图片不包含敏感信息，或使用本地部署的视觉模型（如 Ollama）。
