# dsh-vision-bridge

**Give your text-only DeepSeek Harness agent real image understanding — without switching models.**

**English** | [中文](./README.zh-CN.md)

Vision Bridge lets a **text-only main model** (e.g. `deepseek-v4-flash`) recognize pasted images, OCR text, and answer questions about pictures by routing them to an external **vision-capable model** (e.g. SenseNova / any OpenAI-compatible vision endpoint). The chat keeps showing your original image as a thumbnail — the long description only goes to the model.

## Features

- 🖼 **Paste-to-recognize** — paste any PNG/JPEG/WebP/GIF into the composer and send; no setup required.
- 📝 **OCR** — transcribes visible text (Chinese / English / code) faithfully.
- 🗣 **Image Q&A** — ask "what's in this screenshot?", "what does this error say?" and get answers grounded in the image.
- 🧰 **`vision_analyze` tool** — say `analyze /path/to/image.png` and the model calls the tool on any file path.
- 📷 **Composer camera button** — pick a local file, the instruction is drafted for you.

## How it works

```
You paste an image ──▶ send
  ├─ ① host-apiproxy admission: image messages are allowed through
  ├─ ② conversation log / GUI: image stored as a durable attachment
  │      (thumbnail + your original text — no long descriptions)
  └─ ③ llm/stream layer: before the request reaches the text-only
         adapter, image blocks are replaced with vision-model descriptions
        ▼
     deepseek main model reads the description and answers normally
```

Key design points:

- **Clean chat UI** — the image stays a thumbnail; recognition text never pollutes the message list.
- **Per-attachment cache** — the same image is converted once, not on every request.
- **Vision-model requests pass through** — calls to image-capable models are never double-converted.
- **Auto-discovery of vision models** — any provider that declares `input: ["text","image"]` is picked up automatically (no hard-coded model list). Fresh on `llm/adapters-updated`.
- **Graceful degradation** — with no vision model configured, image messages still send; the model reports "no vision model configured" instead of crashing.

## Requirements

- A running [DeepSeek Harness](https://github.com/deepseek-ai) web profile (`dsh --profile web`)
- A vision-capable model reachable through an `llm-pi-ai` provider profile in `$DSH_HOME/settings.yaml` (SenseNova `sensenova-6.x-flash-lite` verified; any OpenAI-compatible vision endpoint works)

## Installation

```bash
# 1. Clone or copy this repository somewhere on the machine running DSH
git clone https://github.com/<you>/dsh-vision-bridge.git
cd dsh-vision-bridge

# 2. Run the installer (detects your DSH layout; see --help)
bash scripts/install.sh
```

What the installer does:

1. Copies the package into your DSH profile's `node_modules` (`$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-vision-bridge`) — the loader's actual resolution source.
2. Adds the `vision-bridge` row to `$DSH_HOME/profiles/web/cordis.patch.yml` (idempotent).
3. Patches the shipped `dsh-host-apiproxy` `session.prompt` image-admission gate (idempotent; makes image messages reach the agent loop).
4. Prints the settings snippet you need for a vision provider.

> ⚠️ Steps 2–3 modify deployment files. The installer is idempotent and backs up nothing itself — run a DSH upgrade's re-install with the same script afterwards.

### Configure a vision provider (example: SenseNova)

In `$DSH_HOME/settings.yaml`:

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

Set the key in `$DSH_HOME/.credentials.yaml` (or the environment), then **fully restart the DSH service process** (quit the app, verify port 3080 is free, reopen) — patch layers and the browser plugin roster load at startup.

## Usage

| Action | How |
|---|---|
| Paste an image | Paste / drag it into the composer, press Enter |
| Upload via button | Click 📷 in the composer, pick a file, press Enter |
| Analyze a file path | `分析 /path/to/image.png` — the agent calls `vision_analyze` |
| Ask something specific | Paste the image and ask your question in the same message |

## Files

```
dsh-vision-bridge/
├── package.json          # DSH plugin package manifest (dsh.client declaration)
├── lib/
│   ├── index.js          # Host half: vision_analyze tool, /vision-upload route,
│   │                     # llm/stream image→text conversion, vision-model discovery
│   └── client.js         # Client half: composer camera button (__ModuleLoader__ format)
├── scripts/
│   └── install.sh        # One-shot installer (package + patch + apiproxy fix)
├── README.md             # This file (English)
├── README.zh-CN.md       # 中文版说明
└── LICENSE
```

## Notes & limitations

- The main model stays text-only: "seeing" is delegated to a vision model, so each new image costs one vision-model call (a few seconds).
- Vision-model descriptions include reasonable interpretation of scene details; for strict facts (verbatim OCR) ask a targeted question.
- The `/vision-upload` endpoint binds to loopback (127.0.0.1) and is not exposed externally.

## License

[MIT](./LICENSE)