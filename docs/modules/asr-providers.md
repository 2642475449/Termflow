# ASR 提供者模块

## 模块概述

ASR 提供者模块负责管理多个语音识别服务提供者的集成，包括小米 MiMo 和阿里百炼 DashScope。该模块采用统一的接口设计，支持根据模型名称自动选择对应的提供者。

**相关代码位置**：
- `src/lib/mimoAsr.ts` - MiMo ASR 请求构建、响应解析
- `src/lib/dashscopeAsr.ts` - DashScope ASR 请求构建、响应解析
- `src/hooks/useVoiceRecognition.ts` - 语音识别 hook，包含多提供者支持
- `src/components/SettingsPanel.tsx` - ASR 模型选择 UI

## 核心机制

### 1. 提供者识别机制

**机制描述**：根据模型名称自动识别使用哪个 ASR 提供者。

**工作原理**：

1. 定义 DashScope 模型列表：
```typescript
const DASHSCOPE_MODELS: string[] = [
  "fun-asr-flash-2026-06-15",
  "qwen3-asr-flash",
  "qwen3-asr-flash-2026-02-10",
  "qwen3-asr-flash-2025-09-08",
];
```

2. 判断函数：
```typescript
function isDashScopeModel(model: string): boolean {
  return DASHSCOPE_MODELS.includes(model);
}
```

3. 在转录时根据模型类型选择不同的 API 调用方式

**代码位置**：`src/hooks/useVoiceRecognition.ts:25-37`

### 2. MiMo ASR 提供者

**机制描述**：小米 MiMo ASR 的请求构建和响应解析。

**API 配置**：
- **端点**：`https://api.xiaomimimo.com/v1/chat/completions`
- **认证方式**：`api-key` 请求头
- **请求格式**：OpenAI 兼容的 chat completions 格式

**请求构建**：
```typescript
export function buildMimoAsrRequest(audioDataUrl: string, model: string, language = "zh") {
  return {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: {
              data: audioDataUrl,
            },
          },
        ],
      },
    ],
    asr_options: {
      language,
    },
  };
}
```

**响应解析**：支持多种响应格式：
- 直接 `text` 字段
- `choices[].message.content`（字符串或数组）
- `choices[].delta.content`

**代码位置**：`src/lib/mimoAsr.ts`

### 3. DashScope ASR 提供者

**机制描述**：阿里百炼 DashScope ASR 的请求构建和响应解析。

**API 配置**：
- **原生端点**：`https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
- **OpenAI 兼容端点**：`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`
- **认证方式**：`Authorization: Bearer {apiKey}` 请求头

**请求构建**：

原生接口：
```typescript
export function buildDashScopeAsrRequest(audioDataUrl: string, options: DashScopeAsrOptions = {}) {
  const { model = "qwen3-asr-flash", language, enableItn = false } = options;

  return {
    model,
    input: {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: audioDataUrl,
              },
            },
          ],
        },
      ],
    },
    parameters: {
      asr_options: {
        ...(language ? { language } : {}),
        enable_itn: enableItn,
      },
    },
  };
}
```

OpenAI 兼容接口：
```typescript
export function buildOpenAICompatibleAsrRequest(audioDataUrl: string, options: DashScopeAsrOptions = {}) {
  const { model = "qwen3-asr-flash", language, enableItn = false } = options;

  return {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: {
              data: audioDataUrl,
            },
          },
        ],
      },
    ],
    stream: false,
    asr_options: {
      ...(language ? { language } : {}),
      enable_itn: enableItn,
    },
  };
}
```

**响应解析**：
```typescript
export function extractDashScopeAsrText(payload: unknown): string {
  // 检查 output.choices 结构
  const output = (payload as { output?: unknown }).output;
  if (output && typeof output === "object") {
    const choices = (output as { choices?: unknown }).choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const firstChoice = choices[0];
      if (firstChoice && typeof firstChoice === "object") {
        const message = (firstChoice as { message?: unknown }).message;
        if (message && typeof message === "object") {
          const content = (message as { content?: unknown }).content;
          if (typeof content === "string") {
            return content.trim();
          }
          if (Array.isArray(content) && content.length > 0) {
            const firstContent = content[0];
            if (firstContent && typeof firstContent === "object") {
              const text = (firstContent as { text?: unknown }).text;
              if (typeof text === "string") {
                return text.trim();
              }
            }
          }
        }
      }
    }
  }

  // 检查 choices 结构（OpenAI 兼容格式）
  const choices2 = (payload as { choices?: unknown }).choices;
  if (Array.isArray(choices2) && choices2.length > 0) {
    const firstChoice = choices2[0];
    if (firstChoice && typeof firstChoice === "object") {
      const message = (firstChoice as { message?: unknown }).message;
      if (message && typeof message === "object") {
        const content = (message as { content?: unknown }).content;
        if (typeof content === "string") {
          return content.trim();
        }
      }
    }
  }

  return "";
}
```

**代码位置**：`src/lib/dashscopeAsr.ts`

### 4. 多提供者转录流程

**机制描述**：在 `useVoiceRecognition` hook 中实现多提供者的转录逻辑。

**工作流程**：

1. 判断当前模型是否为 DashScope 模型
2. 根据模型类型选择不同的转录方式：
   - DashScope 模型：优先使用 OpenAI 兼容接口，失败时回退到原生接口
   - MiMo 模型：优先使用 fetch 直接调用，遇到 CORS 错误时回退到 Rust 代理

**代码实现**：
```typescript
const transcribe = useCallback(
  async (blob: Blob) => {
    setPhaseRef("transcribing");
    const useRust = readRustProxyPref();
    const currentModel = modelRef.current;
    const useDashScope = isDashScopeModel(currentModel);

    try {
      const preparedAudio = await prepareAudioForAsr(blob);
      let text = "";

      if (useDashScope) {
        // DashScope 模型：使用 OpenAI 兼容接口
        try {
          text = await transcribeWithOpenAICompatible(
            preparedAudio.audioDataUrl,
            currentModel as DashScopeAsrModel,
            apiKeyRef.current,
          );
        } catch (dashScopeErr) {
          // 如果 OpenAI 兼容接口失败，尝试使用原生接口
          if (isCorsLikeError(dashScopeErr)) {
            text = await transcribeWithDashScope(
              preparedAudio.audioDataUrl,
              currentModel as DashScopeAsrModel,
              apiKeyRef.current,
            );
          } else {
            throw dashScopeErr;
          }
        }
      } else if (useRust) {
        // MiMo 模型：使用 Rust 代理
        text = await transcribeWithRustProxy(
          preparedAudio.audioBase64,
          preparedAudio.mimeType,
          currentModel,
          apiKeyRef.current,
        );
      } else {
        // MiMo 模型：直接调用
        try {
          text = await transcribeWithFetch(
            preparedAudio.audioDataUrl,
            currentModel,
            apiKeyRef.current,
          );
        } catch (firstErr) {
          if (isCorsLikeError(firstErr)) {
            writeRustProxyPref(true);
            text = await transcribeWithRustProxy(
              preparedAudio.audioBase64,
              preparedAudio.mimeType,
              currentModel,
              apiKeyRef.current,
            );
          } else {
            throw firstErr;
          }
        }
      }

      if (!text) {
        emitError({ code: "empty_audio", message: "未识别到语音内容" });
        return;
      }
      setLastText(text);
      setPhaseRef("done");
      onResultRef.current?.(text);
      scheduleAutoResetToIdle("done", SUCCESS_SETTLE_MS);
    } catch (err) {
      // 错误处理...
    }
  },
  [emitError, scheduleAutoResetToIdle, setPhaseRef],
);
```

**代码位置**：`src/hooks/useVoiceRecognition.ts:552-622`

### 5. 设置面板集成

**机制描述**：在设置面板中支持选择不同的 ASR 模型。

**模型选项**：
```typescript
const ASR_MODELS = [
  { value: DEFAULT_ASR_MODEL, label: DEFAULT_ASR_MODEL },
  { value: "fun-asr-flash-2026-06-15", label: "Fun-ASR-Flash (阿里百炼)" },
  { value: "qwen3-asr-flash", label: "Qwen3-ASR-Flash (阿里百炼)" },
  { value: "qwen3-asr-flash-2026-02-10", label: "Qwen3-ASR-Flash-2026-02-10 (阿里百炼)" },
];
```

**测试功能**：根据模型类型选择不同的测试方式：
- DashScope 模型：使用 fetch 直接调用 DashScope API
- MiMo 模型：使用 Rust 代理调用

**API Key 申请链接**：
- MiMo：`https://api.xiaomimimo.com/`
- 阿里百炼：`https://bailian.console.aliyun.com/`

**代码位置**：`src/components/SettingsPanel.tsx:664-666, 709-748`

## 数据流

```
用户选择模型（SettingsPanel）
    │
    ▼
Zustand Store (asrModel)
    │
    ▼
useVoiceRecognition hook
    │
    ├─ isDashScopeModel(model)
    │       │
    │       ├─ true → DashScope 提供者
    │       │       │
    │       │       ├─ transcribeWithOpenAICompatible()
    │       │       │       │
    │       │       │       ▼
    │       │       │  OpenAI 兼容接口
    │       │       │
    │       │       └─ transcribeWithDashScope() (回退)
    │       │               │
    │       │               ▼
    │       │          原生接口
    │       │
    │       └─ false → MiMo 提供者
    │               │
    │               ├─ transcribeWithFetch()
    │               │       │
    │               │       ▼
    │               │  直接调用
    │               │
    │               └─ transcribeWithRustProxy() (回退)
    │                       │
    │                       ▼
    │                  Rust 代理
    │
    ▼
识别结果返回
```

## 依赖关系

### 内部依赖

| 模块 | 用途 |
|------|------|
| `src/lib/mimoAsr.ts` | MiMo ASR 请求构建、响应解析 |
| `src/lib/dashscopeAsr.ts` | DashScope ASR 请求构建、响应解析 |
| `src/hooks/useVoiceRecognition.ts` | 语音识别 hook，多提供者支持 |
| `src/components/SettingsPanel.tsx` | ASR 模型选择 UI |
| `src/store/index.ts` | ASR 模型状态管理 |

### 外部依赖

| 依赖 | 用途 |
|------|------|
| 小米 MiMo ASR API | MiMo 语音识别服务 |
| 阿里百炼 DashScope API | DashScope 语音识别服务 |
| `@tauri-apps/api` (invoke) | Rust 代理调用 |

## 配置选项

### ASR 模型

在设置面板中可以选择以下模型：

| 模型 | 提供者 | 说明 |
|------|--------|------|
| `mimo-v2.5-asr` | 小米 MiMo | 默认模型 |
| `fun-asr-flash-2026-06-15` | 阿里百炼 | Fun-ASR-Flash，支持上下文增强 |
| `qwen3-asr-flash` | 阿里百炼 | Qwen3-ASR-Flash，支持流式输出 |
| `qwen3-asr-flash-2026-02-10` | 阿里百炼 | Qwen3-ASR-Flash 最新快照版 |

### API Key

- MiMo API Key：在 `https://api.xiaomimimo.com/` 申请
- 阿里百炼 API Key：在 `https://bailian.console.aliyun.com/` 申请

## 注意事项

1. **API Key 通用性**：MiMo 和阿里百炼使用不同的 API Key，需要分别申请
2. **CORS 问题**：浏览器直接调用 API 可能遇到 CORS 限制，系统会自动回退到 Rust 代理
3. **模型选择**：根据实际需求选择合适的模型，不同模型的功能和性能有所不同
4. **错误处理**：系统会自动处理各种错误情况，并提供友好的错误提示

## 修改历史

- **2026-06-26**: 初始实现，支持 MiMo 和 DashScope 多提供者
