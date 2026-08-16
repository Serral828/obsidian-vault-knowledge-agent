# Vault Knowledge Agent

[![CI](https://github.com/Serral828/obsidian-vault-knowledge-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Serral828/obsidian-vault-knowledge-agent/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Serral828/obsidian-vault-knowledge-agent?display_name=tag)](https://github.com/Serral828/obsidian-vault-knowledge-agent/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一个以当前 Obsidian Vault 为知识边界、回答可追溯、写入可审阅的知识管理 Agent。

它直接连接本地或云端 OpenAI 兼容模型服务，不依赖 Codex、Claude Code 或其他 Agent 运行时。

## 特性

- 在右侧栏中对整个当前 Vault 提问，而不局限于当前笔记。
- 本地混合索引 Markdown、Canvas、Base、TXT、标签、属性与双链。
- 回答引用可点击的 Vault 内部链接和来源条目。
- 模型列表来自服务的 `/v1/models`，不内置或猜测模型名称。
- 支持 Ollama、LM Studio、vLLM 及云端 OpenAI 兼容 API。
- 云端仅接收问题、最小会话历史及本地检索出的相关片段。
- 新增、修改、移动与删除必须先生成变更提案并由用户逐项确认。
- 图片只记录路径与知识关系，不执行 OCR。
- 用户触发运行，无后台自治；会话和索引只保存在当前设备。

## 安装

### 从 Release 安装

1. 在 [Releases](https://github.com/Serral828/obsidian-vault-knowledge-agent/releases) 下载 `vault-knowledge-agent.zip`。
2. 解压后，将其中的 `main.js`、`manifest.json` 和 `styles.css` 放入 `<Vault>/.obsidian/plugins/vault-knowledge-agent/`。
3. 在 Obsidian 的“第三方插件”中启用 **Vault Knowledge Agent**。

Release 中单独列出的三个运行文件用于兼容 Obsidian 官方安装和更新机制；普通用户直接下载 ZIP 即可。

### 从源码构建

```bash
npm install
npm run typecheck
npm run build
```

构建结果为仓库根目录中的 `main.js`。

## 使用

1. 点击右侧栏中的插件图标。
2. 点击齿轮，添加本地或云端模型连接。
3. 从模型服务读取真实模型列表并选择聊天模型。
4. 首次使用时手动建立 Knowledge Index。
5. 开始询问、审计或整理当前 Vault。

OpenAI 兼容服务可填写根地址或 `/v1` 地址。例如，Ollama 的常见根地址为 `http://127.0.0.1:11434`。

## 隐私与权限

- API Key 写入 Obsidian SecretStorage，不写进 Vault 笔记。
- Knowledge Index、模型连接与 Task Session 保存在设备本地。
- 云端连接不会上传完整 Vault 或完整索引，并可启用发送前预览。
- 默认工具只能访问当前 Vault；可选的 Vault Filesystem Mode 仍禁止 Shell 和 Vault 外路径。
- 所有写操作都需要用户确认；删除会送入操作系统回收站。

更完整的边界说明见 [领域模型](docs/domain-model.md) 与 [架构决策记录](docs/adr/README.md)。

## 开发

```bash
npm run dev       # 监听并重新构建
npm run typecheck # TypeScript 检查
npm run build     # 生产构建
```

提交代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## License

[MIT](LICENSE) © 2026 Serral828
