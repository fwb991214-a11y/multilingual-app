import {
  DEEPL_REQUEST_TIMEOUT_MS,
  fetchWithTimeout,
  OPENAI_REQUEST_TIMEOUT_MS,
} from "./fetch-timeout.server";
import { truncateForDisplay } from "./errors.server";
import { sanitizeTranslationOutput } from "./sanitize.server";
import type {
  ShopSettingsRecord,
  TranslationProvider,
} from "./types";

interface TranslateOptions {
  text: string;
  sourceLocale: string;
  targetLocale: string;
  isHtml: boolean;
  settings: ShopSettingsRecord;
  /** 单条字段翻译超时（毫秒），默认见 OPENAI_REQUEST_TIMEOUT_MS */
  timeoutMs?: number;
}

function mockTranslate(text: string, targetLocale: string, isHtml: boolean) {
  const prefix = `[${targetLocale.toUpperCase()}]`;
  if (isHtml) {
    return text.replace(/>([^<]+)</g, (_match, content: string) => {
      const trimmed = content.trim();
      if (!trimmed) {
        return `>${content}<`;
      }
      return `>${prefix} ${trimmed}<`;
    });
  }
  return `${prefix} ${text}`;
}

async function translateWithOpenAI(options: TranslateOptions) {
  const apiKey = options.settings.openaiApiKey;
  if (!apiKey) {
    throw new Error("未配置 OpenAI API Key，请先在设置页填写");
  }

  const systemPrompt = options.isHtml
    ? "You are a professional e-commerce translator. Translate only visible text inside HTML fragments. Keep existing tags, attributes, URLs, and structure unchanged. Return ONLY the translated HTML fragment. Do NOT add <html>, <head>, <body>, markdown code fences, or explanations."
    : "You are a professional e-commerce translator. Return only the translated plain text without quotes, HTML wrappers, or explanations.";

  const model = options.settings.openaiModel || "gpt-4o-mini";

  const response = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Source language: ${options.sourceLocale}\nTarget language: ${options.targetLocale}\n\n${options.text}`,
          },
        ],
      }),
    },
    options.timeoutMs ?? OPENAI_REQUEST_TIMEOUT_MS,
    `OpenAI (${model})`,
  );

  if (!response.ok) {
    const errorText = await response.text();
    let detail = truncateForDisplay(errorText);
    try {
      const parsed = JSON.parse(errorText) as {
        error?: { message?: string; type?: string };
      };
      if (parsed.error?.message) {
        detail = parsed.error.type
          ? `${parsed.error.type}: ${parsed.error.message}`
          : parsed.error.message;
      }
    } catch {
      /* 非 JSON 则使用原文截断 */
    }
    throw new Error(
      `OpenAI API 错误 HTTP ${response.status}：${truncateForDisplay(detail)}`,
    );
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const raw = json.choices?.[0]?.message?.content?.trim();
  if (!raw) {
    throw new Error("OpenAI 返回空翻译结果");
  }

  return sanitizeTranslationOutput(raw, options.isHtml);
}

async function translateWithDeepL(options: TranslateOptions) {
  const apiKey = options.settings.deeplApiKey;
  if (!apiKey) {
    throw new Error("未配置 DeepL API Key，请先在设置页填写");
  }

  const endpoint = apiKey.endsWith(":fx")
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate";

  const body = new URLSearchParams({
    text: options.text,
    source_lang: normalizeDeepLLocale(options.sourceLocale),
    target_lang: normalizeDeepLLocale(options.targetLocale),
  });
  if (options.isHtml) {
    body.set("tag_handling", "html");
  }

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
    options.timeoutMs ?? DEEPL_REQUEST_TIMEOUT_MS,
    "DeepL",
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `DeepL API 错误 HTTP ${response.status}：${truncateForDisplay(errorText)}`,
    );
  }

  const json = (await response.json()) as {
    translations?: Array<{ text?: string }>;
  };

  const raw = json.translations?.[0]?.text?.trim();
  if (!raw) {
    throw new Error("DeepL 返回空翻译结果");
  }

  return sanitizeTranslationOutput(raw, options.isHtml);
}

function normalizeDeepLLocale(locale: string) {
  const normalized = locale.split("-")[0]?.toUpperCase() ?? locale.toUpperCase();
  if (normalized === "ZH") {
    return locale.toLowerCase().includes("tw") ? "ZH-HANT" : "ZH-HANS";
  }
  return normalized;
}

export async function translateText(options: TranslateOptions) {
  const provider: TranslationProvider = options.settings.provider;

  switch (provider) {
    case "openai":
      return translateWithOpenAI(options);
    case "deepl":
      return translateWithDeepL(options);
    case "mock":
    default:
      return mockTranslate(
        options.text,
        options.targetLocale,
        options.isHtml,
      );
  }
}

