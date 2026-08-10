# 贡献指南

感谢您对 Termflow 项目的关注！我们欢迎任何形式的贡献。

## 如何贡献

### 报告问题

1. 使用 GitHub Issues 报告 bug
2. 请使用提供的 issue 模板
3. 包含复现步骤和环境信息

### 提交代码

1. Fork 本仓库
2. 创建您的特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交您的更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 打开一个 Pull Request

### 开发环境设置

```bash
# 克隆仓库
git clone https://github.com/yourusername/termflow.git

# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev
```

### 代码规范

- 使用 TypeScript 严格模式
- 遵循 ESLint 和 Prettier 配置
- 组件文件使用 PascalCase 命名
- 工具函数使用 camelCase 命名
- CSS 类名使用 `app-` 前缀

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
