# Termflow 模块文档

本目录包含 Termflow 系统中各个模块的机制文档。每个模块文档记录了该模块的核心机制和工作原理。

## 模块索引

### 核心模块

- [窗口管理](window-management.md) - 窗口创建、销毁、切换、多窗口架构
- [项目管理](project-management.md) - 项目打开、关闭、切换、启动恢复
- [会话管理](session-management.md) - 终端会话生命周期、状态管理
- [设置系统](settings-system.md) - 设置持久化、双轨同步机制

### 功能模块

- [主题系统](theme-system.md) - 主题切换、CSS 变量、跟随系统
- [语音识别](voice-recognition.md) - 语音输入、全局快捷键、悬浮窗
- [ASR 提供者](asr-providers.md) - 多 ASR 服务提供者集成（MiMo、DashScope）
- [Git 集成](git-integration.md) - Git 操作、状态监控、差异对比
- [国际化](internationalization.md) - i18n 机制、语言切换

---

## 文档规范

每个模块文档应包含：

1. **模块概述** - 模块的职责和边界
2. **核心机制** - 模块中的关键机制，每个机制包含：
   - 机制名称
   - 工作原理
   - 相关代码位置
   - 配置选项（如有）
3. **数据流** - 模块内部和外部的数据流动
4. **依赖关系** - 与其他模块的依赖关系

## 添加新模块

1. 在本目录下创建新的 Markdown 文件
2. 文件名使用 kebab-case 格式
3. 按照文档规范编写内容
4. 更新本索引文件
