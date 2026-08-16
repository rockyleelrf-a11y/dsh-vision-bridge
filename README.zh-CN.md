# dsh-vision-bridge

**让纯文本模型也能"看见"图片——无需切换主模型。**

[English](./README.md) | **中文**

Vision Bridge（视觉桥）让**纯文本主模型**（如 `deepseek-v4-flash`）能够识别粘贴的图片、读取图片文字（OCR）、回答关于图片的问题——方法是在模型请求发出前，把图片块替换为**外部视觉模型**生成的文字描述。聊天界面里图片仍然以**缩略图**展示，长描述只进入模型上下文，不会污染消息列表。

## 功能特性

- 🖼 **粘贴即识别** — 在输入框粘贴任意 PNG/JPEG/WebP/GIF 图片并发送，无需任何设置。
- 📝 **OCR 文字识别** — 忠实转录图中可见文字（中文 / 英文 / 代码）。
- 🗣 **图片问答** — 直接问"这个截图里有什么？""这个报错是什么意思？"，回答基于图片内容。
- 🧰 **`vision_analyze` 工具** — 说"分析 /path/to/image.png"，模型自动调用工具识别任意文件路径。
- 📷 **输入栏上传按钮** — 点选本地图片文件，指令自动填入。

## 工作原理（三层设计）

```
你粘贴图片 ──▶ 发送
  ├─ ① host-apiproxy 准入：图片消息放行（不再拒绝文本模型收图）
  ├─ ② 会话日志 / 界面：图片以 durable 附件存储
  │      （缩略图 + 你的原文 —— 不出现长文本）
  └─ ③ llm/stream 层：请求到达纯文本适配器之前，
         图片块被替换为视觉模型生成的描述
        ▼
     deepseek 主模型读到描述 → 正常回答
```

关键设计：

- **聊天界面干净** — 图片保持缩略图；识别文本永远不会进入消息列表。
- **按附件缓存** — 同一张图只转换一次（历史图片不会每次都重复调用）。
- **视觉模型请求放行** — 对已声明图片输入的模型发起的调用不会被二次转换。
- **视觉模型自动发现** — 任何声明了 `input: ["text","image"]` 的 provider 会自动接入（不写死模型列表），并在 `llm/adapters-updated` 时刷新。
- **优雅降级** — 未配置视觉模型时，图片消息照常发送，模型会报告"未配置可用的视觉模型"而不是崩溃。

## 环境要求

- 正在运行的 [DeepSeek Harness](https://github.com/deepseek-ai) web profile（`dsh --profile web`）
- 一个可通过 `llm-pi-ai` provider 配置访问的**视觉模型**（已验证 SenseNova `sensenova-6.x-flash-lite`；任意 OpenAI 兼容的视觉端点均可）

## 安装

```bash
# 1. 克隆或在运行 DSH 的机器上复制本仓库
git clone https://github.com/rockyleelrf-a11y/dsh-vision-bridge.git
cd dsh-vision-bridge

# 2. 运行安装脚本（自动探测 DSH 目录布局；--help 查看选项）
bash scripts/install.sh
```

安装脚本会做三件事（均幂等可重跑）：

1. 把插件包复制到 DSH profile 的 `node_modules`（`$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-vision-bridge`）——这是 loader 实际解析加载的位置。
2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加 `vision-bridge` 组合行。
3. 给官方 `dsh-host-apiproxy` 打 `session.prompt` 图片准入补丁（幂等；让图片消息能进入 agent loop）。

> ⚠️ 第 2–3 步会修改部署文件。脚本幂等且不自行备份——DSH 升级后请用同一脚本重新执行。

### 配置视觉 provider（示例：SenseNova）

在 `$DSH_HOME/settings.yaml` 中：

```yaml
llm-pi-ai:
  providers:
    sense:
      displayName: SenseNova
      apiKeyEnv: SENSE_API_KEY
      api: openai-completions
      baseURL: https://token.sensenova.cn/v1
      models:
        - id: sensenova-6.8-flash-lite
          name: sensenova-6.8-flash-lite
          contextWindow: 262144
          input: [text, image]
```

在 `$DSH_HOME/.credentials.yaml`（或环境变量）中配置密钥，然后**完全重启 DSH 服务进程**（退出应用 → 确认端口 3080 已释放 → 重新打开）——组合配置与浏览器插件花名册均在启动时加载。

## 使用方式

| 操作 | 方法 |
|---|---|
| 粘贴图片 | 粘贴 / 拖拽到输入框，回车发送 |
| 按钮上传 | 点击输入栏 📷，选择文件，回车 |
| 识别文件路径 | `分析 /path/to/image.png` — 模型自动调用 `vision_analyze` |
| 针对性提问 | 粘贴图片并在同一条消息里写下你的问题 |

## 目录结构

```
dsh-vision-bridge/
├── package.json          # DSH 插件包清单（dsh.client 声明）
├── lib/
│   ├── index.js          # Host 半部：vision_analyze 工具、/vision-upload 路由、
│   │                     # llm/stream 图片→文字转换、视觉模型自动发现
│   └── client.js         # Client 半部：输入栏 📷 按钮（__ModuleLoader__ 格式）
├── scripts/
│   └── install.sh        # 一键安装（包复制 + 组合行 + apiproxy 补丁）
└── README.md             # 本文件（英文版见 README.zh-CN.md 的英文对应）
```

## 注意事项与限制

- 主模型仍是纯文本："看见"是借来的（经视觉模型转换），**每张新图片产生一次视觉模型调用**（约几秒）。
- 视觉模型对画面细节的描述包含合理推测；需要严格事实（如逐字 OCR）时请提出针对性问题。
- `/vision-upload` 端点只绑定回环地址（127.0.0.1），不对外暴露。

## 许可证

[MIT](./LICENSE)