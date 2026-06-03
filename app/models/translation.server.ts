import prisma from "../db.server";
import type {
  ShopSettingsRecord,
  TranslationJobSummary,
  TranslationMode,
  TranslationProvider,
  TranslatableResourceType,
} from "../services/translation/types";

export async function getOrCreateShopSettings(shop: string) {
  return prisma.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
}

export async function updateShopSettings(
  shop: string,
  data: {
    provider?: TranslationProvider;
    openaiApiKey?: string | null;
    openaiModel?: string;
    deeplApiKey?: string | null;
    sourceLocale?: string;
  },
) {
  return prisma.shopSettings.upsert({
    where: { shop },
    update: data,
    create: {
      shop,
      ...data,
    },
  });
}

export function toShopSettingsRecord(
  settings: Awaited<ReturnType<typeof getOrCreateShopSettings>>,
): ShopSettingsRecord {
  return {
    provider: settings.provider as ShopSettingsRecord["provider"],
    openaiApiKey: settings.openaiApiKey,
    openaiModel: settings.openaiModel,
    deeplApiKey: settings.deeplApiKey,
    sourceLocale: settings.sourceLocale,
  };
}

export async function createTranslationJob(input: {
  shop: string;
  resourceTypes: TranslatableResourceType[];
  targetLocales: string[];
  mode: TranslationMode;
}) {
  return prisma.translationJob.create({
    data: {
      shop: input.shop,
      resourceTypes: JSON.stringify(input.resourceTypes),
      targetLocales: JSON.stringify(input.targetLocales),
      mode: input.mode,
      status: "pending",
    },
  });
}

export async function getTranslationJob(jobId: string, shop: string) {
  return prisma.translationJob.findFirst({
    where: { id: jobId, shop },
  });
}

const STALE_RUNNING_MS = 30 * 60 * 1000;

/** 将长时间无更新的 running 任务标为失败，避免 Vercel/本地中断后永远显示「进行中」。 */
export async function markStaleRunningJobs(shop: string) {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS);
  await prisma.translationJob.updateMany({
    where: {
      shop,
      status: "running",
      updatedAt: { lt: cutoff },
    },
    data: {
      status: "failed",
      errorMessage:
        "任务超时或后台进程中断（部署到 Vercel 时需保持 waitUntil；本地需保持 dev 终端运行）",
    },
  });
}

export async function listTranslationJobs(shop: string, limit = 20) {
  await markStaleRunningJobs(shop);
  return prisma.translationJob.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function serializeTranslationJob(
  job: Awaited<ReturnType<typeof listTranslationJobs>>[number],
): TranslationJobSummary {
  return {
    id: job.id,
    status: job.status,
    resourceTypes: parseJsonArray<string>(job.resourceTypes),
    targetLocales: parseJsonArray<string>(job.targetLocales),
    mode: job.mode as TranslationMode,
    totalItems: job.totalItems,
    processedItems: job.processedItems,
    translatedItems: job.translatedItems,
    skippedItems: job.skippedItems,
    failedItems: job.failedItems,
    errorMessage: job.errorMessage,
    logs: parseJsonArray<string>(job.logs),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export async function appendJobLog(jobId: string, message: string) {
  const job = await prisma.translationJob.findUnique({ where: { id: jobId } });
  if (!job) {
    return;
  }

  const logs = parseJsonArray<string>(job.logs);
  logs.push(`${new Date().toISOString()} ${message}`);
  const trimmedLogs = logs.slice(-100);

  await prisma.translationJob.update({
    where: { id: jobId },
    data: { logs: JSON.stringify(trimmedLogs) },
  });
}

export async function updateJobProgress(
  jobId: string,
  data: Partial<{
    status: string;
    totalItems: number;
    processedItems: number;
    translatedItems: number;
    skippedItems: number;
    failedItems: number;
    errorMessage: string | null;
  }>,
) {
  await prisma.translationJob.update({
    where: { id: jobId },
    data,
  });
}
