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

/** 将长时间无更新的 running 任务标为失败；进度已满但未收尾的标为已完成。 */
export async function markStaleRunningJobs(shop: string) {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS);

  const runningJobs = await prisma.translationJob.findMany({
    where: { shop, status: "running" },
  });

  for (const job of runningJobs) {
    // 进度条满只表示「已扫描」完，已译/跳过仍会继续增加；仅当长时间无更新才自动收尾
    if (
      job.totalItems > 0 &&
      job.processedItems >= job.totalItems &&
      job.updatedAt < cutoff
    ) {
      await prisma.translationJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
          errorMessage: null,
        },
      });
      const logs = parseJsonArray<string>(job.logs);
      if (!logs.some((line) => line.includes("任务完成"))) {
        logs.push(`${new Date().toISOString()} 任务完成（进度已满且已停止更新，自动收尾）`);
        await prisma.translationJob.update({
          where: { id: job.id },
          data: { logs: JSON.stringify(logs.slice(-100)) },
        });
      }
      continue;
    }

    if (job.updatedAt < cutoff) {
      await prisma.translationJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          errorMessage:
            "任务超时或后台进程中断（Vercel 函数 300s 超时；请重新部署最新代码）",
        },
      });
    }
  }
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
  if (!data.status) {
    const existing = await prisma.translationJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    if (existing?.status === "completed") {
      return;
    }
  }

  await prisma.translationJob.update({
    where: { id: jobId },
    data,
  });
}
