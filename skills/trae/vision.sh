#!/usr/bin/env bash
# vision.sh — 调用外部视觉 API 识别图片
# 用法: bash vision.sh <image_path> [question]
# 环境变量:
#   VISION_API_KEY  (必填) API 密钥
#   VISION_API_URL  (可选) API 地址，默认 OpenAI
#   VISION_MODEL    (可选) 模型名称，默认 gpt-4o

set -euo pipefail

IMAGE_PATH="${1:-}"
QUESTION="${2:-请用中文详细描述这张图片的内容，包括主要物体、场景、可见文字（OCR）、颜色和细节。}"

if [ -z "$IMAGE_PATH" ]; then
  echo "错误：请提供图片路径" >&2
  echo "用法: bash vision.sh <image_path> [question]" >&2
  exit 1
fi

if [ ! -f "$IMAGE_PATH" ]; then
  echo "错误：文件不存在: $IMAGE_PATH" >&2
  exit 1
fi

API_KEY="${VISION_API_KEY:-}"
API_URL="${VISION_API_URL:-https://api.openai.com/v1/chat/completions}"
MODEL="${VISION_MODEL:-gpt-4o}"

if [ -z "$API_KEY" ]; then
  echo "错误：请设置 VISION_API_KEY 环境变量" >&2
  echo "提示: export VISION_API_KEY='sk-your-key'" >&2
  exit 1
fi

# 检测 MIME 类型
MIME=""
case "${IMAGE_PATH,,}" in
  *.png)  MIME="image/png" ;;
  *.jpg|*.jpeg) MIME="image/jpeg" ;;
  *.webp) MIME="image/webp" ;;
  *.gif)  MIME="image/gif" ;;
  *)      MIME=$(file --mime-type -b "$IMAGE_PATH" 2>/dev/null || echo "image/png") ;;
esac

# 图片转 base64
BASE64=$(base64 < "$IMAGE_PATH" 2>/dev/null || base64 -i "$IMAGE_PATH" 2>/dev/null || echo "")
if [ -z "$BASE64" ]; then
  echo "错误：无法读取图片文件" >&2
  exit 1
fi

# 调用视觉 API
RESPONSE=$(curl -s -m 120 "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":$(echo "$QUESTION" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')},{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:$MIME;base64,$BASE64\"}}]}],\"max_tokens\":1500}" 2>/dev/null) || {
  echo "错误：API 请求失败（网络错误）" >&2
  exit 1
}

# 解析响应
echo "$RESPONSE" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    if 'error' in d:
        print(f'API 错误: {d[\"error\"].get(\"message\", str(d[\"error\"]))}')
        sys.exit(1)
    content = d['choices'][0]['message']['content']
    print(content)
except Exception as e:
    print(f'解析响应失败: {e}')
    sys.exit(1)
"
