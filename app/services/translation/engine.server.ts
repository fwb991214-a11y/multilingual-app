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
    ? "You are a professional e-commerce translator. Translate only visible text inside HTML tags. Keep all HTML tags, attributes, URLs, and structure unchanged. Return only the translated HTML."
    : "You are a professional e-commerce translator. Return only the translated text without quotes or explanations.";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.settings.openaiModel || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Source language: ${options.sourceLocale}\nTarget language: ${options.targetLocale}\n\n${options.text}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI 翻译失败: ${errorText}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const translated = json.choices?.[0]?.message?.content?.trim();
  if (!translated) {
    throw new Error("OpenAI 返回空翻译结果");
  }

  return translated;
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

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepL 翻译失败: ${errorText}`);
  }

  const json = (await response.json()) as {
    translations?: Array<{ text?: string }>;
  };

  const translated = json.translations?.[0]?.text?.trim();
  if (!translated) {
    throw new Error("DeepL 返回空翻译结果");
  }

  return translated;
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

