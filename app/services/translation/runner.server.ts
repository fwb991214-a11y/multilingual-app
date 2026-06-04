import { unauthenticated } from "../../shopify.server";
import {
  appendJobLog,
  getTranslationJob,
  setJobActivity,
  toShopSettingsRecord,
  updateJobProgress,
} from "../../models/translation.server";
import {
  formatProviderError,
  textPreview,
} from "./errors.server";
import { getProviderLabel } from "./labels";
import prisma from "../../db.server";
import {
  fetchResourceWithTranslations,
  fetchTranslatableResourcesPage,
  registerTranslationsWithFallback,
  sleep,
} from "./graphql.server";
import { translateText } from "./engine.server";
import {
  HTML_CONTENT_KEYS,
  isNonTranslatableKey,
  isNonTranslatableValue,
  type AdminGraphqlClient,
  type ExistingTranslation,
  type ShopSettingsRecord,
  type TranslatableContentItem,
  type TranslatableResourceType,
  RESOURCE_TYPE_LABELS,
  type TranslationInputPayload,
  type TranslationMode,
} from "./types";

const PAGE_SIZE = 20;
const REGISTER_BATCH_SIZE = 25;
const TRANSLATION_DELAY_MS = 120;
const ACTIVITY_THROTTLE_MS = 2500;

function shortResourceId(resourceId: string) {
  const parts = resourceId.split("/");
  return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : resourceId;
}

function shouldTranslateField(input: {
  content: TranslatableContentItem;
  existing: ExistingTranslation | undefined;
  mode: TranslationMode;
  sourceLocale: string;
}) {
  if (!input.content.value?.trim()) {
    return false;
  }

  if (isNonTranslatableKey(input.content.key)) {
    return false;
  }

  if (isNonTranslatableValue(input.content.value)) {
    return false;
  }

  if (input.content.locale !== input.sourceLocale) {
    return false;
  }

  if (!input.existing) {
    return true;
  }

  switch (input.mode) {
    case "all":
      return true;
    case "outdated_only":
      return input.existing.outdated;
    case "missing_only":
    default:
      return !input.existing.value?.trim();
  }
}

async function getAdminForShop(shop: string): Promise<AdminGraphqlClient> {
  const { admin } = await unauthenticated.admin(shop);
  return admin;
}

export async function processTranslationJob(jobId: string, shop: string) {
  const job = await getTranslationJob(jobId, shop);
  if (!job) {
    return;
  }

  if (job.status === "completed") {
    return;
  }

  if (job.status === "running") {
    const staleMs = 30 * 60 * 1000;
    if (Date.now() - job.updatedAt.getTime() < staleMs) {
      return;
    }
    await updateJobProgress(jobId, {
      status: "failed",
      errorMessage: "任务已超时，正在重新执行",
    });
    await appendJobLog(jobId, "检测到陈旧 running 状态，重新执行");
  }

  const resourceTypes = JSON.parse(job.resourceTypes) as TranslatableResourceType[];
  const targetLocales = JSON.parse(job.targetLocales) as string[];

  const settingsRow = await prisma.shopSettings.findUnique({ where: { shop } });
  const settings: ShopSettingsRecord = settingsRow
    ? toShopSettingsRecord(settingsRow)
    : {
        provider: "mock",
        openaiApiKey: null,
        openaiModel: "gpt-4o-mini",
        deeplApiKey: null,
        sourceLocale: "en",
      };

  await updateJobProgress(jobId, {
    status: "running",
    errorMessage: null,
    processedItems: 0,
    translatedItems: 0,
    skippedItems: 0,
    failedItems: 0,
  });
  const providerLabel = getProviderLabel(settings.provider);
  const modelHint =
    settings.provider === "openai" && settings.openaiModel
      ? ` (${settings.openaiModel})`
      : "";

  await appendJobLog(jobId, `任务开始，目标语言: ${targetLocales.join(", ")}`);
  await setJobActivity(
    jobId,
    `任务开始 · 引擎 ${providerLabel}${modelHint}`,
  );

  try {
    const admin = await getAdminForShop(shop);
    let totalItems = 0;
    let processedItems = 0;
    let translatedItems = 0;
    let skippedItems = 0;
    let failedItems = 0;
    let lastActivityAt = 0;

    const reportActivity = async (message: string, force = false) => {
      const now = Date.now();
      if (!force && now - lastActivityAt < ACTIVITY_THROTTLE_MS) {
        return;
      }
      lastActivityAt = now;
      await setJobActivity(jobId, message);
    };

    for (const resourceType of resourceTypes) {
      let cursor: string | null = null;
      let hasNextPage = true;

      await appendJobLog(jobId, `开始处理资源类型 ${resourceType}`);
      await reportActivity(
        `正在扫描 ${RESOURCE_TYPE_LABELS[resourceType] ?? resourceType} 列表…`,
        true,
      );

      while (hasNextPage) {
        await reportActivity(
          `正在拉取 ${RESOURCE_TYPE_LABELS[resourceType] ?? resourceType} 分页数据…`,
        );

        const page = await fetchTranslatableResourcesPage(
          admin,
          resourceType,
          cursor,
          PAGE_SIZE,
        );

        await updateJobProgress(jobId, {
          processedItems,
          translatedItems,
          skippedItems,
          failedItems,
          totalItems,
        });

        for (const edge of page.edges) {
          const resourceId = edge.node.resourceId;
          const sourceContent = edge.node.translatableContent.filter(
            (item) => item.locale === settings.sourceLocale,
          );

          totalItems += sourceContent.length * targetLocales.length;

          for (const targetLocale of targetLocales) {
            if (targetLocale === settings.sourceLocale) {
              continue;
            }

            try {
              await reportActivity(
                `正在读取 ${shortResourceId(resourceId)} 的 ${targetLocale} 译文…`,
              );

              const resource = await fetchResourceWithTranslations(
                admin,
                resourceId,
                targetLocale,
              );

              if (!resource) {
                skippedItems += sourceContent.length;
                processedItems += sourceContent.length;
                continue;
              }

              const existingMap = new Map(
                resource.translations.map((item) => [item.key, item]),
              );

              const pendingTranslations: TranslationInputPayload[] = [];

              let fieldsHandledInBlock = 0;

              for (const content of sourceContent) {
                fieldsHandledInBlock += 1;

                const existing = existingMap.get(content.key);
                if (
                  !shouldTranslateField({
                    content,
                    existing,
                    mode: job.mode as TranslationMode,
                    sourceLocale: settings.sourceLocale,
                  })
                ) {
                  skippedItems += 1;
                  continue;
                }

                try {
                  const doneSoFar = processedItems + fieldsHandledInBlock;
                  const progressHint =
                    totalItems > 0
                      ? ` · 进度 ${doneSoFar}/${totalItems}`
                      : "";

                  await reportActivity(
                    `正在请求 ${providerLabel}${modelHint} · ${shortResourceId(resourceId)} [${content.key}] → ${targetLocale} · 约 ${content.value.length} 字 · 「${textPreview(content.value)}」${progressHint}`,
                    true,
                  );

                  const translatedValue = await translateText({
                    text: content.value,
                    sourceLocale: settings.sourceLocale,
                    targetLocale,
                    isHtml: HTML_CONTENT_KEYS.has(content.key),
                    settings,
                  });

                  pendingTranslations.push({
                    locale: targetLocale,
                    key: content.key,
                    value: translatedValue,
                    translatableContentDigest: content.digest,
                  });

                  await reportActivity(
                    `✓ ${providerLabel} 完成 [${content.key}] → ${targetLocale}${progressHint}`,
                  );

                  await sleep(TRANSLATION_DELAY_MS);
                } catch (error) {
                  failedItems += 1;
                  const message = formatProviderError(
                    providerLabel,
                    error,
                    `翻译失败 ${shortResourceId(resourceId)} [${content.key}] → ${targetLocale}`,
                  );
                  await appendJobLog(jobId, message);
                  await reportActivity(`✗ ${message}`, true);
                }
              }

              if (pendingTranslations.length > 0) {
                await reportActivity(
                  `正在上传 ${pendingTranslations.length} 条译文到 Shopify (${shortResourceId(resourceId)}, ${targetLocale})…`,
                  true,
                );
              }

              for (
                let index = 0;
                index < pendingTranslations.length;
                index += REGISTER_BATCH_SIZE
              ) {
                const batch = pendingTranslations.slice(
                  index,
                  index + REGISTER_BATCH_SIZE,
                );
                const result = await registerTranslationsWithFallback(
                  admin,
                  resourceId,
                  batch,
                );
                translatedItems += result.succeeded;
                failedItems += result.failed;
                for (const err of result.errors) {
                  await appendJobLog(
                    jobId,
                    `上传跳过 ${resourceId} (${targetLocale}): ${err}`,
                  );
                }
              }

              if (pendingTranslations.length > 0) {
                await appendJobLog(
                  jobId,
                  `已处理 ${pendingTranslations.length} 条待上传: ${resourceId} (${targetLocale})`,
                );
              }

              processedItems += sourceContent.length;
            } catch (error) {
              const message = formatProviderError(
                providerLabel,
                error,
                `资源处理失败 ${shortResourceId(resourceId)} (${targetLocale})`,
              );
              await appendJobLog(jobId, message);
              await reportActivity(`✗ ${message}`, true);
              processedItems += sourceContent.length;
            }

            await updateJobProgress(jobId, {
              totalItems,
              processedItems,
              translatedItems,
              skippedItems,
              failedItems,
            });
          }
        }

        hasNextPage = page.pageInfo.hasNextPage;
        cursor = page.pageInfo.endCursor;
        await sleep(200);
      }
    }

    await updateJobProgress(jobId, {
      status: "completed",
      totalItems,
      processedItems,
      translatedItems,
      skippedItems,
      failedItems,
    });
    await appendJobLog(jobId, "任务完成");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateJobProgress(jobId, {
      status: "failed",
      errorMessage: message,
    });
    await appendJobLog(jobId, `任务失败: ${message}`);
  }
}

/** 在后台执行翻译；Vercel 上必须由 action 里 waitUntil() 包装，不能在此处立即启动 Promise。 */
export function runTranslationJobSafely(jobId: string, shop: string) {
  return processTranslationJob(jobId, shop).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    await updateJobProgress(jobId, {
      status: "failed",
      errorMessage: message,
    });
    await appendJobLog(jobId, `任务异常退出: ${message}`);
  });
}

/** 本地 dev：后台 fire-and-forget */
export function startTranslationJob(jobId: string, shop: string) {
  void runTranslationJobSafely(jobId, shop);
}
