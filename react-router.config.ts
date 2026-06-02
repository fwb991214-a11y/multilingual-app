import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

export default {
  // 作为全栈框架启用 SSR（Shopify embedded app 必须 SSR 才能做 auth/loader）
  ssr: true,
  presets: [vercelPreset()],
} satisfies Config;

