# dsh-file-jump

DSH (DeepSeek Harness) web GUI client plugin — makes file paths in tool call cards jump straight to the VS Code editor, and lets VS Code right-click "Add to DSH" write file references into the DSH input box.

Works together with the VS Code extension [dsh-for-vscode](https://github.com/Jillson1/dsh-for-vscode).

English | [中文](README.zh.md)

## What it does

- **Tool card file jumps**: for `read` / `edit` / `write` tool cards, the file path button carries the absolute path, the edit's old text, and the read line offset (`data-abs-path` / `data-old-text` / `data-line`). Clicking it opens the file in VS Code — `edit` jumps to the exact changed line, `read` jumps to the read start line.
- **Composer injection (Add to DSH)**: listens for the downlink message forwarded by the dsh-vscode-bridge, then seeds the active session's composer draft with the file reference (`@path` or `@path:start-end`) using the official `conversation.input` facade. You review and send it manually — nothing is submitted automatically.

## Requirements

- DSH (DeepSeek Harness) web, rc.8+
- VS Code extension [dsh-for-vscode](https://github.com/Jillson1/dsh-for-vscode) (for the bridge that delivers the downlink)

## Install

### From the repository (development)

```sh
git clone https://github.com/Jillson1/dsh-file-jump.git
cd dsh-file-jump
pnpm install
pnpm build
dsh plugin --profile web add link:D:/dsh/dsh-filejump
```

### From git source

```sh
dsh plugin --profile web add github:Jillson1/dsh-file-jump
```

> Not yet published to npm. Once published: `dsh plugin --profile web add @jillson1/dsh-file-jump@latest`

After installing, restart `dsh web` for the plugin to load.

## Development

```sh
pnpm install
pnpm build        # tsc + tsdown → lib/
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
```

Layout:

```
src/
├── index.ts              # node half (entry)
└── client/
    ├── index.ts          # browser half: registers read/edit/write toolviews
    ├── JumpRow.tsx       # tool card row carrying the jump data attributes
    ├── composerInject.ts # Add to DSH downlink → composer draft
    └── parse.ts          # pure derivation helpers (paths, old text, offsets)
shared/                   # tsdown client-bundle preset (self-contained)
tests/                    # vitest unit tests
```

## License

BSD-3-Clause.
