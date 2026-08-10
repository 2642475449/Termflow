// 阿里百炼 DashScope ASR 集成
// 支持 Fun-ASR-Flash 和 Qwen3-ASR-Flash 模型

export const DASHSCOPE_DEFAULT_MODEL = "qwen3-asr-flash";

// 区域定义
export type DashScopeRegion = "beijing" | "singapore" | "us";

// 区域配置
export const DASHSCOPE_REGIONS: Record<DashScopeRegion, { label: string; endpoint: string; compatibleEndpoint: string }> = {
  beijing: {
    label: "华北2（北京）",
    endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    compatibleEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  },
  singapore: {
    label: "新加坡",
    endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    compatibleEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  },
  us: {
    label: "美国（弗吉尼亚）",
    endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    compatibleEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  },
};

export type DashScopeAsrModel =
  | "fun-asr-flash-2026-06-15"
  | "qwen3-asr-flash"
  | "qwen3-asr-flash-2026-02-10"
  | "qwen3-asr-flash-us";

export interface DashScopeAsrOptions {
  model?: DashScopeAsrModel;
  region?: DashScopeRegion;
  language?: string;
  enableItn?: boolean; // 逆文本正则化
  enableWords?: boolean; // 字级时间戳
  workspaceId?: string; // 业务空间 ID
}

/**
 * 构建 DashScope ASR 请求体（DashScope 原生接口）
 * 注意：原生接口使用 {"audio": "url"} 格式
 */
export function buildDashScopeAsrRequest(
  audioDataUrl: string,
  options: DashScopeAsrOptions = {},
) {
  const {
    model = DASHSCOPE_DEFAULT_MODEL,
    language,
    enableItn = false,
  } = options;

  // Fun-ASR-Flash 需要 format 和 sample_rate 参数
  const isFunAsrFlash = model.startsWith("fun-asr-flash");

  return {
    model,
    input: {
      messages: [
        {
          role: "user",
          content: [
            {
              audio: audioDataUrl,
            },
          ],
        },
      ],
    },
    parameters: {
      ...(isFunAsrFlash ? { format: "wav", sample_rate: "16000" } : {}),
      asr_options: {
        ...(language ? { language } : {}),
        enable_itn: enableItn,
      },
    },
  };
}

/**
 * 构建 OpenAI 兼容接口请求体
 */
export function buildOpenAICompatibleAsrRequest(
  audioDataUrl: string,
  options: DashScopeAsrOptions = {},
) {
  const {
    model = DASHSCOPE_DEFAULT_MODEL,
    language,
    enableItn = false,
  } = options;

  // Fun-ASR-Flash 需要 format 和 sample_rate 参数
  const isFunAsrFlash = model.startsWith("fun-asr-flash");

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
    ...(isFunAsrFlash ? { format: "wav", sample_rate: "16000" } : {}),
    asr_options: {
      ...(language ? { language } : {}),
      enable_itn: enableItn,
    },
  };
}

/**
 * 从 DashScope 响应中提取识别文本
 */
export function extractDashScopeAsrText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

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

/**
 * 从 DashScope 错误响应中提取错误信息
 */
export function extractDashScopeApiErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  // 检查 code + message 结构
  const code = (payload as { code?: unknown }).code;
  const message = (payload as { message?: unknown }).message;
  if (typeof code === "string" && typeof message === "string") {
    return `${code}: ${message}`;
  }

  // 检查 error 结构
  const error = (payload as { error?: unknown }).error;
  if (error && typeof error === "object") {
    const errMessage = (error as { message?: unknown }).message;
    if (typeof errMessage === "string") {
      return errMessage.trim();
    }
  }

  if (typeof message === "string") {
    return message.trim();
  }

  return "";
}

/**
 * 获取 DashScope API 端点
 */
export function getDashScopeEndpoint(region: DashScopeRegion = "beijing", workspaceId?: string): string {
  if (workspaceId) {
    const regionDomain = region === "beijing" ? "cn-beijing" : region === "singapore" ? "ap-southeast-1" : "us-east-1";
    return `https://${workspaceId}.${regionDomain}.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`;
  }
  return DASHSCOPE_REGIONS[region].endpoint;
}

/**
 * 获取 OpenAI 兼容接口端点
 */
export function getOpenAICompatibleEndpoint(region: DashScopeRegion = "beijing", workspaceId?: string): string {
  if (workspaceId) {
    const regionDomain = region === "beijing" ? "cn-beijing" : region === "singapore" ? "ap-southeast-1" : "us-east-1";
    return `https://${workspaceId}.${regionDomain}.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
  }
  return DASHSCOPE_REGIONS[region].compatibleEndpoint;
}
