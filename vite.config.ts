import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import fs from "node:fs";
import path from "node:path";

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

if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

// When developing with Shopify CLI, the tunnel URL changes. If env isn't set,
// read the latest tunnel URL from the CLI-generated manifest to keep HMR/WebSocket working.
if (!process.env.SHOPIFY_APP_URL) {
  const manifestUrl = resolveDevAppUrlFromManifest();
  if (manifestUrl) {
    process.env.SHOPIFY_APP_URL = manifestUrl;
  }
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost")
  .hostname;

let hmrConfig;
if (host === "localhost") {
  hmrConfig = {
    protocol: "ws",
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  hmrConfig = {
    protocol: "wss",
    host: host,
    port: parseInt(process.env.FRONTEND_PORT!) || 8002,
    clientPort: 443,
  };
}

export default defineConfig({
  server: {
    allowedHosts: [host],
    cors: {
      preflightContinue: true,
    },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      allow: ["app", "node_modules"],
    },
  },
  plugins: [reactRouter(), tsconfigPaths()],
  build: {
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react"],
  },
}) satisfies UserConfig;
