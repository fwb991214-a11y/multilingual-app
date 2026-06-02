import type { TranslationProvider } from "./types";

export function getProviderLabel(provider: TranslationProvider) {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "deepl":
      return "DeepL";
    default:
      return "Mock（测试）";
  }
}
