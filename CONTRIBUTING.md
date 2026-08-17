# 贡献指南

感谢您对 Termflow 项目的关注！我们欢迎任何形式的贡献。

## 如何贡献

### 报告问题

1. 使用 GitHub Issues 报告 bug 或提出功能建议
2. 包含复现步骤、预期与实际结果、日志或截图，以及环境信息

### 提交代码

1. Fork 本仓库
2. 创建您的特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交您的更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 打开一个 Pull Request

### 开发环境设置

```bash
# Fork 后克隆自己的仓库（将 <your-account> 替换为 GitHub 用户名）
git clone https://github.com/<your-account>/Termflow.git
cd Termflow
git remote add upstream https://github.com/2642475449/Termflow.git

# 安装依赖
pnpm install

# 启动完整桌面应用
pnpm tauri dev
```

### 代码规范

- 使用 TypeScript 严格模式
- 组件文件使用 PascalCase 命名
- 工具函数使用 camelCase 命名
- CSS 类名使用 `app-` 前缀
- 提交前运行 `pnpm test` 和 `pnpm build`；涉及 Rust 后端时，在 `src-tauri/` 目录运行 `cargo test`

### 提交信息规范

使用约定式提交格式：

```
<type>(<scope>): <subject>

<body>

<footer>
```

类型包括：
- `feat`: 新功能
- `fix`: 修复 bug
- `docs`: 文档更新
- `style`: 代码格式调整
- `refactor`: 重构
- `test`: 测试相关
- `chore`: 构建/工具链更新
