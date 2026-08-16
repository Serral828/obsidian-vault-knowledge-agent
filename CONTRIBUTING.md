# Contributing

欢迎提交 Issue 与 Pull Request。

## 本地开发

1. 安装 Node.js 20 或更高版本。
2. 运行 `npm install`。
3. 运行 `npm run typecheck` 和 `npm run build`。
4. 将 `main.js`、`manifest.json`、`styles.css` 复制到测试 Vault 的插件目录。

## Pull Request

- 保持 Agent 的访问边界为当前 Vault。
- 不得绕过 Change Proposal 直接写入或删除笔记。
- 不得记录或提交 API Key、Vault 内容与本机路径。
- 行为或安全边界发生变化时，请同步更新 README 和相关 ADR。
