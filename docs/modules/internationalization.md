# 国际化模块

## 模块概述

国际化模块负责应用的多语言支持，包括语言切换、翻译资源管理和 Ant Design 语言包集成。

**相关代码位置**：
- `src/i18n.ts` - i18next 初始化配置
- `src/locales/zh-CN.json` - 中文翻译资源
- `src/locales/en-US.json` - 英文翻译资源
- `src/App.tsx` - 语言同步逻辑
- `src/components/SettingsPanel.tsx` - 语言切换 UI

## 核心机制

### 1. i18n 初始化配置

**机制描述**：应用启动时初始化 i18next，配置支持的语言和翻译资源。

**工作原理**：

1. 在 `main.tsx` 中通过 `import "./i18n"` 触发模块级初始化
2. i18next 配置两种语言：`zh-CN` 和 `en-US`
3. 默认语言为 `zh-CN`，回退语言也为 `zh-CN`
4. 禁用 HTML 转义（`escapeValue: false`）

**代码位置**：`src/i18n.ts:1-22`

```typescript
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./locales/zh-CN.json";
import enUS from "./locales/en-US.json";

export function toI18nLanguage(language: "zh_CN" | "en") {
  return language === "en" ? "en-US" : "zh-CN";
}

void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    "en-US": { translation: enUS },
  },
  lng: "zh-CN",
  fallbackLng: "zh-CN",
  interpolation: {
    escapeValue: false,
  },
});
```

### 2. 语言切换机制

**机制描述**：用户在设置面板切换语言时，同步更新 i18next、HTML lang 属性和 Ant Design 语言包。

**工作原理**：

1. 用户在设置面板选择语言（`zh_CN` 或 `en`）
2. 调用 Zustand store 的 `setLanguage` action 更新状态
3. 触发 `useEffect` 同步语言设置：
   - 调用 `i18n.changeLanguage()` 更新 i18next 实例
   - 设置 `document.documentElement.lang` 属性
4. 250ms 防抖后持久化到 SQLite

**代码位置**：`src/App.tsx:194-200`

```typescript
useEffect(() => {
  const nextLanguage = toI18nLanguage(language);
  if (i18n.language !== nextLanguage) {
    void i18n.changeLanguage(nextLanguage);
  }
  document.documentElement.setAttribute("lang", nextLanguage);
}, [language]);
```

**语言选项定义**：`src/components/SettingsPanel.tsx:333-336`

```typescript
const langOptions = [
  { label: t("settings.languageName.zh_CN"), value: "zh_CN" },
  { label: t("settings.languageName.en"), value: "en" },
];
```

### 3. 翻译资源结构

**机制描述**：翻译资源使用扁平嵌套 JSON 结构，按功能模块组织。

**顶级命名空间**：

| 命名空间 | 说明 |
|---------|------|
| `common` | 通用操作词（确认、取消、复制等） |
| `titleBar` | 标题栏 |
| `statusBar` | 状态栏（含 context、effort 子对象） |
| `home` | 首页（含 overview 统计面板） |
| `sidebar` | 侧边栏（文件面板、Git 面板、会话管理） |
| `projectLauncher` | 项目启动器 |
| `tabBar` | 标签栏 |
| `fileTabs` | 文件标签 |
| `terminal` | 终端 |
| `settings` | 设置页（含多个子模块） |
| `sounds` | 音效名称 |

**插值语法**：支持 `{{variable}}` 插值

```json
{
  "sessionDefaultName": "会话 {{time}}",
  "unread": "未读 {{count}}"
}
```

**代码位置**：
- `src/locales/zh-CN.json` (909 行)
- `src/locales/en-US.json` (909 行)

### 4. 语言持久化方式

**机制描述**：语言设置通过 SQLite 持久化，不通过 Zustand localStorage 持久化。

**双层持久化机制**：

#### 层 1: SQLite 持久化（主存储）

语言设置包含在 `persistentSettings` 对象中，通过 Tauri 后端 API 持久化：

- **启动时**：`initializePersistentSettings()` 从 SQLite 读取 → `applyPersistentSettingsToStore()` 恢复到 store
- **变更时**：250ms 防抖后调用 `savePersistentSettings()` 写入 SQLite

**代码位置**：`src/App.tsx:62-84`

```typescript
const persistentSettings = useMemo(
  () => ({
    lightTheme,
    darkTheme,
    themeCategory,
    language,  // 语言设置
    startupRestoreLastProject,
    // ...
  }),
  [language, /* ... */]
);
```

#### 层 2: Zustand localStorage（不包含语言）

注意：`partialize` 函数**未包含 language 字段**，这意味着 Zustand 的 localStorage 持久化不保存语言设置。

**值标准化**：`src/store/index.ts:99-101`

```typescript
function normalizeLanguageValue(language: string | null | undefined): Language {
  return language === "en" ? "en" : "zh_CN";
}
```

默认值为 `"zh_CN"`。

### 5. Ant Design 语言包集成

**机制描述**：Ant Design 组件的语言包根据当前语言设置动态切换。

**工作原理**：

1. 导入 Ant Design 的中文和英文语言包
2. 在 `ConfigProvider` 中根据 `language` 状态设置 `locale` prop
3. Ant Design 组件（Modal、DatePicker 等）自动使用对应语言

**代码位置**：`src/App.tsx:3-4, 203-204`

```typescript
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";

// 在 ConfigProvider 中使用
<ConfigProvider locale={language === "en" ? enUS : zhCN} ...>
```

### 6. HTML lang 属性更新

**机制描述**：语言切换时同步更新 HTML `lang` 属性，确保浏览器和辅助技术正确识别语言。

**工作原理**：

1. 使用 `toI18nLanguage()` 将 store 值转换为 i18next 标准值
2. 设置 `document.documentElement.setAttribute("lang", nextLanguage)`
3. 确保 `<html lang="zh-CN">` 或 `<html lang="en-US">`

**代码位置**：`src/App.tsx:194-200`

```typescript
useEffect(() => {
  const nextLanguage = toI18nLanguage(language);
  if (i18n.language !== nextLanguage) {
    void i18n.changeLanguage(nextLanguage);
  }
  document.documentElement.setAttribute("lang", nextLanguage);
}, [language]);
```

### 7. 语言值映射

**机制描述**：Zustand store 中的语言值与 i18next 标准值之间的映射。

**映射关系**：

| Store 值 | i188next 值 | HTML lang |
|---------|-------------|-----------|
| `zh_CN` | `zh-CN` | `zh-CN` |
| `en` | `en-US` | `en-US` |

**转换函数**：`src/i18n.ts:6-8`

```typescript
export function toI18nLanguage(language: "zh_CN" | "en") {
  return language === "en" ? "en-US" : "zh-CN";
}
```

## 数据流

```
┌─────────────────────────────────────────────────────────────┐
│                   设置面板 UI                               │
├─────────────────────────────────────────────────────────────┤
│  Segmented 组件 - 语言切换                                    │
│  调用 setLanguage() 更新 store                                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Zustand Store                             │
├─────────────────────────────────────────────────────────────┤
│  language: "zh_CN" | "en"                                    │
│  setLanguage() action                                        │
└─────────────────────────────────────────────────────────────┘
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
┌───────────────────────────┐ ┌───────────────────────────┐
│   i18next                 │ │   SQLite                  │
│   - changeLanguage()      │ │   - savePersistentSettings│
│   - 翻译资源加载           │ │   - 250ms 防抖            │
└───────────────────────────┘ └───────────────────────────┘
                │
                ▼
┌───────────────────────────┐
│   HTML & Ant Design       │
│   - <html lang="...">     │
│   - ConfigProvider locale  │
└───────────────────────────┘
```

## 完整代码位置索引

| 功能 | 文件 | 行号 |
|---|---|---|
| i18n 初始化 + toI18nLanguage | `src/i18n.ts` | 1-22 |
| i18n 模块导入触发 | `src/main.tsx` | 4 |
| 语言状态类型定义 | `src/store/index.ts` | 22 |
| 语言标准化函数 | `src/store/index.ts` | 99-101 |
| setLanguage action | `src/store/index.ts` | 1514 |
| 持久化设置中的 language | `src/store/index.ts` | 68, 135 |
| 从 SQLite 恢复语言 | `src/App.tsx` | 138-159 |
| 保存语言到 SQLite | `src/App.tsx` | 161-184 |
| i18n.changeLanguage + HTML lang | `src/App.tsx` | 194-200 |
| Ant Design ConfigProvider locale | `src/App.tsx` | 203-204 |
| 语言切换 UI (Segmented) | `src/components/SettingsPanel.tsx` | 333-336, 445-453 |
| 中文翻译资源 | `src/locales/zh-CN.json` | 1-909 |
| 英文翻译资源 | `src/locales/en-US.json` | 1-909 |

## 依赖关系

- **设置系统模块** - 语言设置通过设置系统持久化
- **主题系统模块** - 语言切换可能影响主题显示
