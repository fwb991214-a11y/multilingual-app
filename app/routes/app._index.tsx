import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Link, useFetcher, useLoaderData, useLocation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  createTranslationJob,
  getOrCreateShopSettings,
  listTranslationJobs,
  serializeTranslationJob,
  toShopSettingsRecord,
} from "../models/translation.server";
import { fetchShopLocales } from "../services/translation/graphql.server";
import { waitUntil } from "@vercel/functions";
import {
  runTranslationJobSafely,
  startTranslationJob,
} from "../services/translation/runner.server";
import { getProviderLabel } from "../services/translation/labels";
import {
  RESOURCE_TYPE_LABELS,
  TRANSLATABLE_RESOURCE_TYPES,
  TRANSLATION_MODES,
  type TranslatableResourceType,
  type TranslationMode,
} from "../services/translation/types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const [shopLocales, settings, jobs] = await Promise.all([
    fetchShopLocales(admin),
    getOrCreateShopSettings(shop),
    listTranslationJobs(shop, 5),
  ]);

  const primaryLocale =
    shopLocales.find((locale) => locale.primary)?.locale ?? "en";
  const targetLocales = shopLocales
    .filter((locale) => !locale.primary)
    .map((locale) => locale.locale);

  return {
    shopLocales,
    primaryLocale,
    targetLocales,
    settings: toShopSettingsRecord(settings),
    recentJobs: jobs.map(serializeTranslationJob),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const resourceTypes = formData
    .getAll("resourceTypes")
    .map(String) as TranslatableResourceType[];
  const targetLocales = formData.getAll("targetLocales").map(String);
  const mode = String(formData.get("mode") || "missing_only") as TranslationMode;

  if (resourceTypes.length === 0) {
    return { ok: false, error: "请至少选择一种资源类型" };
  }

  if (targetLocales.length === 0) {
    return { ok: false, error: "请至少选择一种目标语言" };
  }

  const job = await createTranslationJob({
    shop: session.shop,
    resourceTypes,
    targetLocales,
    mode,
  });

  if (process.env.VERCEL) {
    waitUntil(runTranslationJobSafely(job.id, session.shop));
  } else {
    startTranslationJob(job.id, session.shop);
  }

  return { ok: true, jobId: job.id };
};

export default function TranslateDashboard() {
  const { primaryLocale, targetLocales, settings, recentJobs } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const location = useLocation();
  const search = location.search || "";

  const isSubmitting =
    fetcher.state === "submitting" || fetcher.state === "loading";

  useEffect(() => {
    if (fetcher.data?.ok) {
      shopify.toast.show("翻译任务已创建，正在后台处理");
    } else if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  return (
    <div>
      <h1 className="page-title">批量翻译</h1>

      {fetcher.data?.ok && (
        <div className="banner-success">翻译任务已创建，请到「任务记录」查看进度。</div>
      )}
      {fetcher.data?.error && (
        <div className="banner-error">{fetcher.data.error}</div>
      )}

      <div className="section">
        <h2>说明</h2>
        <p>
          通过 Shopify Translation API 读取可翻译内容，使用{" "}
          {getProviderLabel(settings.provider)} 翻译后写回店铺，不占用 Translate
          &amp; Adapt 自动翻译额度。
        </p>
        <p>
          店铺主语言：<strong>{primaryLocale}</strong>。请在「翻译设置」中配置
          API Key 与源语言。
        </p>
      </div>

      <fetcher.Form method="post">
        <div className="section">
          <h2>选择资源类型</h2>
          {TRANSLATABLE_RESOURCE_TYPES.map((type) => (
            <label key={type} className="checkbox-row">
              <input
                type="checkbox"
                name="resourceTypes"
                value={type}
                defaultChecked={type === "PRODUCT"}
              />{" "}
              {RESOURCE_TYPE_LABELS[type]}
            </label>
          ))}
        </div>

        <div className="section">
          <h2>目标语言</h2>
          {targetLocales.length === 0 ? (
            <div className="banner-warning">
              尚未启用其他语言。请先在 Shopify 后台 Settings → Languages
              中添加并发布目标语言。
            </div>
          ) : (
            targetLocales.map((locale) => (
              <label key={locale} className="checkbox-row">
                <input
                  type="checkbox"
                  name="targetLocales"
                  value={locale}
                  defaultChecked
                />{" "}
                {locale}
              </label>
            ))
          )}
        </div>

        <div className="section">
          <h2>翻译模式</h2>
          <div className="field">
            <label htmlFor="mode">模式</label>
            <select id="mode" name="mode" defaultValue="missing_only">
              {TRANSLATION_MODES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          type="submit"
          className="btn-primary"
          disabled={isSubmitting || targetLocales.length === 0}
        >
          {isSubmitting ? "创建任务中..." : "开始批量翻译"}
        </button>
      </fetcher.Form>

      <div className="section">
        <h2>最近任务</h2>
        {recentJobs.length === 0 ? (
          <p>暂无任务记录</p>
        ) : (
          recentJobs.map((job) => (
            <div key={job.id} className="job-card">
              <p>
                {job.status} · {job.translatedItems} 已译 / {job.skippedItems}{" "}
                跳过 / {job.failedItems} 失败
              </p>
              <p>
                语言: {job.targetLocales.join(", ")} · 资源:{" "}
                {job.resourceTypes.join(", ")}
              </p>
            </div>
          ))
        )}
        <p>
          <Link to={`/app/jobs${search}`}>查看全部任务 →</Link>
        </p>
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
