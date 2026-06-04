export const TRANSLATABLE_RESOURCE_TYPES = [
  "PRODUCT",
  "COLLECTION",
  "PAGE",
  "ARTICLE",
  "BLOG",
  "ONLINE_STORE_THEME",
  "MENU",
] as const;

export type TranslatableResourceType =
  (typeof TRANSLATABLE_RESOURCE_TYPES)[number];

export type TranslationMode = "all" | "missing_only" | "outdated_only";

export type TranslationProvider = "mock" | "openai" | "deepl";

/** Vercel 单次函数最长约 300s，分片续跑时持久化进度。 */
export interface TranslationJobResumeState {
  resourceTypeIndex: number;
  pageCursor: string | null;
  totalItems: number;
  processedItems: number;
  translatedItems: number;
  skippedItems: number;
  failedItems: number;
  /** 已处理过的 Shopify 资源 ID（商品/页面等），用于统计，非字段数 */
  processedResourceIds?: string[];
}

export const TRANSLATION_MODES: { value: TranslationMode; label: string }[] = [
  { value: "missing_only", label: "仅翻译缺失项" },
  { value: "outdated_only", label: "仅翻译过期项" },
  { value: "all", label: "全部重新翻译" },
];

export const RESOURCE_TYPE_LABELS: Record<TranslatableResourceType, string> = {
  PRODUCT: "产品",
  COLLECTION: "集合",
  PAGE: "页面",
  ARTICLE: "博客文章",
  BLOG: "博客",
  ONLINE_STORE_THEME: "主题文案",
  MENU: "导航菜单",
};

export const SKIP_TRANSLATION_KEYS = new Set(["handle"]);

/** 主题/设置里多为 URL、图片路径，翻译后会触发 Shopify 校验失败 */
const NON_TRANSLATABLE_KEY_PATTERNS = [
  /(?:^|\.)(image|url|link|href|src|video|favicon|logo|icon)(?:_\d+|\d+)?$/i,
  /_link(?:_\d+)?$/i,
  /_url(?:_\d+)?$/i,
  /button_link/i,
  /shopify:\/\/shop_images\//i,
];

export function isNonTranslatableKey(key: string) {
  if (SKIP_TRANSLATION_KEYS.has(key)) {
    return true;
  }
  return NON_TRANSLATABLE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function isNonTranslatableValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return true;
  }
  if (/^shopify:\/\//i.test(trimmed)) {
    return true;
  }
  if (/^mailto:/i.test(trimmed)) {
    return true;
  }
  if (/^#[\w-]+$/.test(trimmed)) {
    return true;
  }
  if (
    /^\/[\w\-/%]+$/.test(trimmed) &&
    !/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(trimmed)
  ) {
    return true;
  }
  if (/\.(jpe?g|png|gif|webp|svg|ico|mp4|webm)(\?.*)?$/i.test(trimmed)) {
    return true;
  }
  return false;
}

export const HTML_CONTENT_KEYS = new Set([
  "body_html",
  "description_html",
  "content_html",
]);

export interface TranslatableContentItem {
  key: string;
  value: string;
  digest: string;
  locale: string;
}

export interface ExistingTranslation {
  key: string;
  value: string;
  outdated: boolean;
}

export interface TranslationInputPayload {
  locale: string;
  key: string;
  value: string;
  translatableContentDigest: string;
}

export interface ShopLocale {
  locale: string;
  name: string;
  primary: boolean;
  published: boolean;
}

export interface ShopSettingsRecord {
  provider: TranslationProvider;
  openaiApiKey: string | null;
  openaiModel: string;
  deeplApiKey: string | null;
  sourceLocale: string;
}

export interface TranslationJobSummary {
  id: string;
  status: string;
  resourceTypes: string[];
  targetLocales: string[];
  mode: TranslationMode;
  totalItems: number;
  processedItems: number;
  translatedItems: number;
  skippedItems: number;
  failedItems: number;
  errorMessage: string | null;
  logs: string[];
  activityMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};
