# dsh-file-jump

DSH（DeepSeek Harness）Web GUI 客户端插件——让工具调用卡片里的文件路径一键跳到 VS Code 编辑区，并支持在 VS Code 右键 "Add to DSH" 把文件引用写入 DSH 输入框。

与 VS Code 扩展 [dsh-for-vscode](https://github.com/Jillson1/dsh-for-vscode) 配合使用。

[English](README.md) | 中文

## 功能

- **工具卡片文件跳转**：`read` / `edit` / `write` 工具卡片的文件路径按钮携带绝对路径、edit 的改前片段与 read 的读取偏移（`data-abs-path` / `data-old-text` / `data-line`）。点击后在 VS Code 中打开文件——`edit` 精确定位到修改起始行，`read` 定位到读取起始行。
- **写入输入框（Add to DSH）**：监听 dsh-vscode-bridge 转发的下行消息，通过官方 `conversation.input` 门面把文件引用（`@路径` 或 `@路径:起始-结束`）写入当前会话的 composer 草稿。由你审阅后手动发送，不会自动提交。

## 环境要求

- DSH（DeepSeek Harness）web，rc.8+
- VS Code 扩展 [dsh-for-vscode](https://github.com/Jillson1/dsh-for-vscode)（负责下行消息的桥接）

## 安装

### 从仓库安装（开发调试）

```sh
git clone https://github.com/Jillson1/dsh-file-jump.git
cd dsh-file-jump
pnpm install
pnpm build
dsh plugin --profile web add link:D:/dsh/dsh-filejump
```

### 从 git 源安装

```sh
dsh plugin --profile web add github:Jillson1/dsh-file-jump
```

> 尚未发布到 npm。发布后可用：`dsh plugin --profile web add @jillson1/dsh-file-jump@latest`

安装后重启 `dsh web` 使插件生效。

## 开发

```sh
pnpm install
pnpm build        # tsc + tsdown → lib/
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
```

目录结构：

```
src/
├── index.ts              # node 端入口
└── client/
    ├── index.ts          # 浏览器端：注册 read/edit/write 工具视图
    ├── JumpRow.tsx       # 工具卡片行（携带跳转 data 属性）
    ├── composerInject.ts # Add to DSH 下行 → composer 草稿
    └── parse.ts          # 纯派生逻辑（路径、改前片段、偏移）
shared/                   # tsdown 客户端 bundle 预设（自包含）
tests/                    # vitest 单元测试
```

## 许可证

BSD-3-Clause。
