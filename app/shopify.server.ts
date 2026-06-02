import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import fs from "node:fs";
import path from "node:path";
import prisma from "./db.server";

function resolveDevAppUrlFromManifest(): string | null {
  try {
    const manifestPath = path.join(
      process.cwd(),
      ".shopify",
      "dev-bundle",
      "manifest.json",
    );
    const raw = fs.readFileSync(manifestPath, "utf8");
    const json = JSON.parse(raw) as {
      modules?: Array<{ type?: string; config?: { app_url?: string } }>;
    };
    const appUrl = json.modules?.find((m) => m.type === "app_home")?.config
      ?.app_url;
    return typeof appUrl === "string" && appUrl.startsWith("https://")
      ? appUrl
      : null;
  } catch {
    return null;
  }
}

function resolveShopifyAppUrl(): string {
  if (process.env.SHOPIFY_APP_URL?.trim()) {
    return process.env.SHOPIFY_APP_URL.trim();
  }

  const host = process.env.HOST?.trim();
  if (host) {
    // Some environments provide HOST without protocol.
    return host.startsWith("http://") || host.startsWith("https://")
      ? host
      : `https://${host}`;
  }

  return resolveDevAppUrlFromManifest() ?? "";
}

const resolvedAppUrl = resolveShopifyAppUrl();
if (!process.env.SHOPIFY_APP_URL && resolvedAppUrl) {
  process.env.SHOPIFY_APP_URL = resolvedAppUrl;
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: resolvedAppUrl,
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
