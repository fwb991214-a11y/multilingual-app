import { unauthenticated } from "../../shopify.server";
import {
  parseResumeState,
  triggerTranslationJobRun,
} from "../../lib/job-trigger.server";
import {
  appendJobLog,
  getTranslationJob,
  saveJobResumeState,
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
  type TranslationJobResumeState,
  type TranslationMode,
} from "./types";

const PAGE_SIZE = 20;
const REGISTER_BATCH_SIZE = 25;
const TRANSLATION_DELAY_MS = 120;
const ACTIVITY_THROTTLE_MS = 2500;
/** Vercel 单次调用上限 300s，提前切片并触发下一次独立调用。 */
/** 略小于 Vercel 300s，且避免单次 OpenAI 堆积触发 504 */
const CHUNK_TIME_BUDGET_MS = 3 * 60 * 1000;
const DUPLICATE_RUN_GUARD_MS = 60 * 1000;
/** 单条字段翻译最长等待；超时则跳过并记入日志（避免卡死在 body_html）。 */
const FIELD_TRANSLATE_TIMEOUT_MS = 90 * 1000;
/** 超长 HTML（如含 iframe 的商品详情）直接跳过，避免 OpenAI 极慢或超时。 */
const MAX_HTML_FIELD_CHARS = 5000;

function isTimeoutLikeError(error: unknown) {
  const message =
    error instanceof Error ? error.message : String(error);
  return message.includes("超时") || message.includes("AbortError");
}

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

export async function processTranslationJob(
  jobId: string,
  shop: string,
  options?: { isContinuation?: boolean; appOrigin?: string },
) {
  const job = await getTranslationJob(jobId, shop);
  if (!job) {
    return;
  }

  if (job.status === "completed") {
    return;
  }

  const isContinuation = options?.isContinuation === true;
  const resume = parseResumeState(job.resumeState);
  const isResume = isContinuation && resume != null;

  if (job.status === "running" && !isContinuation) {
    const age = Date.now() - job.updatedAt.getTime();
    if (age < DUPLICATE_RUN_GUARD_MS) {
      return;
    }
    const staleMs = 30 * 60 * 1000;
    if (age < staleMs) {
      return;
    }
    await updateJobProgress(jobId, {
      status: "failed",
      errorMessage: "任务已超时，正在重新执行",
      resumeState: null,
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

  const providerLabel = getProviderLabel(settings.provider);
  const modelHint =
    settings.provider === "openai" && settings.openaiModel
      ? ` (${settings.openaiModel})`
      : "";

  if (!isResume) {
    await updateJobProgress(jobId, {
      status: "running",
      errorMessage: null,
      processedItems: 0,
      translatedItems: 0,
      skippedItems: 0,
      failedItems: 0,
      resumeState: null,
    });
    await appendJobLog(jobId, `任务开始，目标语言: ${targetLocales.join(", ")}`);
    await setJobActivity(
      jobId,
      `任务开始 · 引擎 ${providerLabel}${modelHint}`,
    );
  } else {
    await updateJobProgress(jobId, {
      status: "running",
      errorMessage: null,
    });
    await appendJobLog(jobId, "续跑下一批（独立函数调用）");
    await setJobActivity(
      jobId,
      `续跑任务 · ${providerLabel}${modelHint} · 已从进度 ${resume.processedItems}/${resume.totalItems} 继续`,
      true,
    );
  }

  try {
    const admin = await getAdminForShop(shop);
    let totalItems = resume?.totalItems ?? 0;
    let processedItems = resume?.processedItems ?? 0;
    let translatedItems = resume?.translatedItems ?? 0;
    let skippedItems = resume?.skippedItems ?? 0;
    let failedItems = resume?.failedItems ?? 0;
    let lastActivityAt = 0;
    const chunkStartedAt = Date.now();

    const reportActivity = async (message: string, force = false) => {
      const now = Date.now();
      if (!force && now - lastActivityAt < ACTIVITY_THROTTLE_MS) {
        return;
      }
      lastActivityAt = now;
      await setJobActivity(jobId, message);
    };

    const shouldYieldChunk = () =>
      Date.now() - chunkStartedAt >= CHUNK_TIME_BUDGET_MS;

    const processedResourceIds = new Set<string>();
    if (resume?.processedResourceIds) {
      for (const id of resume.processedResourceIds) {
        processedResourceIds.add(id);
      }
    }

    const scheduleContinuation = async (
      state: TranslationJobResumeState,
    ) => {
      try {
        const stateWithResources: TranslationJobResumeState = {
          ...state,
          processedResourceIds: [...processedResourceIds],
        };
        await saveJobResumeState(jobId, stateWithResources);
        await appendJobLog(
          jobId,
          `本批接近 Vercel 时限，已保存进度（已处理 ${processedResourceIds.size} 个资源），正在自动续跑…`,
        );
        await reportActivity(
          `本批已满约 3 分钟，续跑下一批（已处理 ${processedResourceIds.size} 个资源）…`,
          true,
        );
        void triggerTranslationJobRun(
          options?.appOrigin ?? "",
          jobId,
          shop,
          { continuation: true },
        ).then(async (trigger) => {
          if (!trigger.ok) {
            await appendJobLog(
              jobId,
              `自动续跑触发失败：${trigger.error}。请在任务详情点击「继续本任务」。`,
            );
            await updateJobProgress(jobId, {
              errorMessage:
                "自动续跑失败，进度已保存。请点击「继续本任务」或重新批量翻译",
            });
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendJobLog(jobId, `续跑调度异常: ${message}`);
        await updateJobProgress(jobId, {
          errorMessage:
            "自动续跑异常，进度已保存。请点击「继续本任务」",
        });
      }
      return;
    };

    const typeStartIndex = resume?.resourceTypeIndex ?? 0;
    const initialCursor =
      resume?.pageCursor != null && typeStartIndex < resourceTypes.length
        ? resume.pageCursor
        : null;

    for (let typeIndex = typeStartIndex; typeIndex < resourceTypes.length; typeIndex++) {
      const resourceType = resourceTypes[typeIndex];
      let cursor = typeIndex === typeStartIndex ? initialCursor : null;
      let hasNextPage = true;

      await appendJobLog(jobId, `开始处理资源类型 ${resourceType}`);
      await reportActivity(
        `正在扫描 ${RESOURCE_TYPE_LABELS[resourceType] ?? resourceType} 列表…`,
        true,
      );

      while (hasNextPage) {
        if (shouldYieldChunk()) {
          await scheduleContinuation({
            resourceTypeIndex: typeIndex,
            pageCursor: cursor,
            totalItems,
            processedItems,
            translatedItems,
            skippedItems,
            failedItems,
          });
          return;
        }

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
          if (shouldYieldChunk()) {
            await scheduleContinuation({
              resourceTypeIndex: typeIndex,
              pageCursor: cursor,
              totalItems,
              processedItems,
              translatedItems,
              skippedItems,
              failedItems,
            });
            return;
          }

          const resourceId = edge.node.resourceId;
          processedResourceIds.add(resourceId);
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
                if (shouldYieldChunk()) {
                  await scheduleContinuation({
                    resourceTypeIndex: typeIndex,
                    pageCursor: cursor,
                    totalItems,
                    processedItems,
                    translatedItems,
                    skippedItems,
                    failedItems,
                  });
                  return;
                }

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

                const isHtml = HTML_CONTENT_KEYS.has(content.key);
                const charLen = content.value.length;

                if (isHtml && charLen > MAX_HTML_FIELD_CHARS) {
                  skippedItems += 1;
                  const skipMsg = `过长跳过 ${shortResourceId(resourceId)} [${content.key}] → ${targetLocale}（${charLen} 字，上限 ${MAX_HTML_FIELD_CHARS}）`;
                  await appendJobLog(jobId, skipMsg);
                  await reportActivity(`⊘ ${skipMsg}`, true);
                  continue;
                }

                try {
                  const doneSoFar = processedItems + fieldsHandledInBlock;
                  const progressHint =
                    totalItems > 0
                      ? ` · 进度 ${doneSoFar}/${totalItems}`
                      : "";

                  await reportActivity(
                    `正在请求 ${providerLabel}${modelHint} · ${shortResourceId(resourceId)} [${content.key}] → ${targetLocale} · 约 ${charLen} 字 · 「${textPreview(content.value)}」${progressHint}`,
                    true,
                  );

                  const translatedValue = await translateText({
                    text: content.value,
                    sourceLocale: settings.sourceLocale,
                    targetLocale,
                    isHtml,
                    settings,
                    timeoutMs: FIELD_TRANSLATE_TIMEOUT_MS,
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
                  if (isTimeoutLikeError(error)) {
                    skippedItems += 1;
                    const skipMsg = `超时跳过 ${shortResourceId(resourceId)} [${content.key}] → ${targetLocale}（等待超过 ${FIELD_TRANSLATE_TIMEOUT_MS / 1000} 秒）`;
                    await appendJobLog(jobId, skipMsg);
                    await reportActivity(`⊘ ${skipMsg}`, true);
                    continue;
                  }
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
              const detail =
                error instanceof Error ? error.message : String(error);
              const message = `资源处理失败 ${shortResourceId(resourceId)} (${targetLocale})：${detail}`;
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

    await saveJobResumeState(jobId, null);
    await updateJobProgress(jobId, {
      status: "completed",
      totalItems,
      processedItems,
      translatedItems,
      skippedItems,
      failedItems,
      resumeState: null,
    });
    await appendJobLog(
      jobId,
      `任务完成：共处理 ${processedResourceIds.size} 个资源（商品/页面等）；已译 ${translatedItems} 个字段，跳过 ${skippedItems} 个字段，失败 ${failedItems} 个字段`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateJobProgress(jobId, {
      status: "failed",
      errorMessage: message,
    });
    await appendJobLog(jobId, `任务失败: ${message}`);
  }
}

export function runTranslationJobSafely(
  jobId: string,
  shop: string,
  options?: { isContinuation?: boolean; appOrigin?: string },
) {
  return processTranslationJob(jobId, shop, options).catch(async (error) => {
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
