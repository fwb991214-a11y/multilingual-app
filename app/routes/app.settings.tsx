import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getOrCreateShopSettings,
  toShopSettingsRecord,
  updateShopSettings,
} from "../models/translation.server";
import { fetchShopLocales } from "../services/translation/graphql.server";
import { getProviderLabel } from "../services/translation/labels";
import type { TranslationProvider } from "../services/translation/types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [settings, shopLocales] = await Promise.all([
    getOrCreateShopSettings(session.shop),
    fetchShopLocales(admin),
  ]);

  return {
    settings: toShopSettingsRecord(settings),
    shopLocales,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const provider = String(formData.get("provider") || "mock") as TranslationProvider;
  const sourceLocale = String(formData.get("sourceLocale") || "en");
  const openaiApiKey = String(formData.get("openaiApiKey") || "").trim() || null;
  const openaiModel = String(formData.get("openaiModel") || "gpt-4o-mini");
  const deeplApiKey = String(formData.get("deeplApiKey") || "").trim() || null;

  await updateShopSettings(session.shop, {
    provider,
    sourceLocale,
    openaiApiKey,
    openaiModel,
    deeplApiKey,
  });

  return { ok: true };
};

export default function SettingsPage() {
  const { settings, shopLocales } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  useEffect(() => {
    if (fetcher.data?.ok) {
      shopify.toast.show("设置已保存");
    }
  }, [fetcher.data, shopify]);

  return (
    <div>
      <h1 className="page-title">翻译设置</h1>

      {fetcher.data?.ok && (
        <div className="banner-success">设置已保存</div>
      )}

      <fetcher.Form method="post">
        <div className="section">
          <h2>翻译引擎</h2>
          <div className="field">
            <label htmlFor="provider">提供商</label>
            <select
              id="provider"
              name="provider"
              defaultValue={settings.provider}
            >
              <option value="mock">Mock（测试，无需 API Key）</option>
              <option value="openai">OpenAI</option>
              <option value="deepl">DeepL</option>
            </select>
          </div>
          <p>当前引擎：{getProviderLabel(settings.provider)}</p>
        </div>

        <div className="section">
          <h2>源语言</h2>
          <div className="field">
            <label htmlFor="sourceLocale">店铺主语言（源）</label>
            <select
              id="sourceLocale"
              name="sourceLocale"
              defaultValue={settings.sourceLocale}
            >
              {shopLocales.map((locale) => (
                <option key={locale.locale} value={locale.locale}>
                  {locale.name} ({locale.locale})
                  {locale.primary ? " · 主语言" : ""}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="section">
          <h2>OpenAI</h2>
          <div className="field">
            <label htmlFor="openaiApiKey">OpenAI API Key</label>
            <input
              id="openaiApiKey"
              name="openaiApiKey"
              type="password"
              defaultValue={settings.openaiApiKey ?? ""}
              placeholder="sk-..."
            />
          </div>
          <div className="field">
            <label htmlFor="openaiModel">模型</label>
            <input
              id="openaiModel"
              name="openaiModel"
              type="text"
              defaultValue={settings.openaiModel}
            />
          </div>
        </div>

        <div className="section">
          <h2>DeepL</h2>
          <div className="field">
            <label htmlFor="deeplApiKey">DeepL API Key</label>
            <input
              id="deeplApiKey"
              name="deeplApiKey"
              type="password"
              defaultValue={settings.deeplApiKey ?? ""}
              placeholder="DeepL Auth Key"
            />
          </div>
          <p>免费版 Key 通常以 :fx 结尾，会自动使用 api-free.deepl.com。</p>
        </div>

        <button type="submit" className="btn-primary">
          保存设置
        </button>
      </fetcher.Form>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
