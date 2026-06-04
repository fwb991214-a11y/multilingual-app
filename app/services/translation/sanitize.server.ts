/** 去掉模型常误加的 markdown 围栏或整页 HTML 外壳 */
export function sanitizeTranslationOutput(text: string, isHtml: boolean) {
  let result = text.trim();

  result = result.replace(/^```(?:html|xml|markdown)?\s*\r?\n?/i, "");
  result = result.replace(/\r?\n?```\s*$/i, "");
  result = result.trim();

  if (!isHtml) {
    return result;
  }

  for (let pass = 0; pass < 3; pass++) {
    const before = result;
    result = result.replace(/^<html[^>]*>\s*/i, "");
    result = result.replace(/\s*<\/html>\s*$/i, "");
    result = result.replace(/^<head[^>]*>[\s\S]*?<\/head>\s*/i, "");
    result = result.replace(/^<body[^>]*>\s*/i, "");
    result = result.replace(/\s*<\/body>\s*$/i, "");
    result = result.trim();
    if (result === before) {
      break;
    }
  }

  return result;
}
