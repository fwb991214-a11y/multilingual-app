import type { ActionFunctionArgs } from "react-router";
import { waitUntil } from "@vercel/functions";
import { getInternalJobSecret } from "../lib/job-trigger.server";
import { runTranslationJobSafely } from "../services/translation/runner.server";

export const config = {
  runtime: "nodejs",
  maxDuration: 300,
};

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const secret = getInternalJobSecret();
  const auth = request.headers.get("Authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { jobId?: string; shop?: string };
  try {
    body = (await request.json()) as { jobId?: string; shop?: string };
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const jobId = body.jobId?.trim();
  const shop = body.shop?.trim();
  if (!jobId || !shop) {
    return Response.json({ ok: false, error: "Missing jobId or shop" }, { status: 400 });
  }

  const url = new URL(request.url);
  const isContinuation = url.searchParams.get("continuation") === "1";
  const appOrigin = url.origin;

  if (process.env.VERCEL === "1" || process.env.VERCEL === "true") {
    waitUntil(
      runTranslationJobSafely(jobId, shop, { isContinuation, appOrigin }),
    );
  } else {
    void runTranslationJobSafely(jobId, shop, { isContinuation, appOrigin });
  }

  return Response.json({
    ok: true,
    accepted: true,
    continuation: isContinuation,
  });
}
