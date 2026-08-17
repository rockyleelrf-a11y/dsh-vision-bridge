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
- 🔀 **Any text model works** — the conversion layer is model-agnostic: switch the main model to any text-only model (DeepSeek, or any `llm-pi-ai` route) and pasted images keep working. Both admission gates (paste + model-switch) are patched, so image sessions accept model switches too.

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

1. **Repairs a corrupted `cordis.patch.yml` first** — an earlier installer version blindly appended `- insert:` to the default `[]` template, producing two YAML documents in one file and crashing DSH at startup with a YAML error. The installer detects and fixes this before touching anything.
2. Copies the package into your DSH profile's `node_modules` (`$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-vision-bridge`) — the loader's actual resolution source.
3. Adds the `vision-bridge` row to `$DSH_HOME/profiles/web/cordis.patch.yml` (idempotent; creates/replaces the empty template correctly, never appends to `[]`).
4. Patches the shipped `dsh-host-apiproxy` — **both** admission gates, idempotently:
   - `session.prompt` image admission (lets pasted-image messages reach the agent loop);
   - `selectModel` image admission (lets you switch to a text-only model in a session that already contains images).
5. Prints the settings snippet you need for a vision provider.

A separate `bash scripts/fix-patch.sh` repairs a broken `cordis.patch.yml` on machines where the old installer already corrupted it.

> ⚠️ Steps 2–4 modify deployment files. The installer is idempotent and backs up nothing itself — run a DSH upgrade's re-install with the same script afterwards.

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
│   ├── install.sh        # One-shot installer (package + YAML repair + dual apiproxy patches)
│   └── fix-patch.sh      # Repair a corrupted cordis.patch.yml on machines with the old installer
├── README.md             # This file (English)
├── README.zh-CN.md       # 中文版说明
└── LICENSE
```

## Notes & limitations

- The main model stays text-only: "seeing" is delegated to a vision model, so each new image costs one vision-model call (a few seconds).
- Vision-model descriptions include reasonable interpretation of scene details; for strict facts (verbatim OCR) ask a targeted question.
- The `/vision-upload` endpoint binds to loopback (127.0.0.1) and is not exposed externally.

## Changelog

- **0.2.0** — Multi-model compatibility: patch the `selectModel` admission gate so image sessions accept text-only model switches; fix the `llm/stream` listener (async generator, never a Promise) that previously crashed every request; installer now repairs corrupted `cordis.patch.yml` and patches both admission gates; `fix-patch.sh` added.
- **0.1.0** — Initial release: paste-to-recognize, `vision_analyze` tool, composer button, vision-model auto-discovery.

## License

[MIT](./LICENSE)