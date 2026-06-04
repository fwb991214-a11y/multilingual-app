export function truncateForDisplay(text: string, max = 280) {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…`;
}

export function formatProviderError(
  providerLabel: string,
  error: unknown,
  context?: string,
) {
  const base =
    error instanceof Error ? error.message : String(error);
  const prefix = context
    ? `${providerLabel} ${context}：`
    : `${providerLabel}：`;
  return `${prefix}${truncateForDisplay(base)}`;
}

export function textPreview(text: string, max = 36) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return "（空）";
  }
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}
