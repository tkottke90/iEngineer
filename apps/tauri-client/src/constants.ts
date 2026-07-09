// T020/E1+B3 (FR-007 cloud-key warning): known cloud LLM hostnames. Defined
// ONCE — the Connection tab's warning check and any future API-key forwarding
// logic must both import this list; do not duplicate it.
export const CLOUD_LLM_HOSTNAMES = [
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'openrouter.ai',
];

/** True when the URL's hostname matches a known cloud LLM provider. */
export function isCloudLlmUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return CLOUD_LLM_HOSTNAMES.some((h) => hostname.includes(h));
  } catch {
    return false;
  }
}
