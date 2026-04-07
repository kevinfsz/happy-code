const GENERIC_PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
] as const

export function clearGenericProxyEnv(): void {
  for (const key of GENERIC_PROXY_ENV_KEYS) {
    delete process.env[key]
  }
}
