import type { EntryContext } from "react-router";
import { handleRequest } from "@vercel/react-router/entry.server";
import { addDocumentResponseHeaders } from "./shopify.server";

export default async function entryServer(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext?: unknown,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  return handleRequest(
    request,
    responseStatusCode,
    responseHeaders,
    routerContext,
    loadContext,
  );
}
