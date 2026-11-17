export const JUPITER_API_BASE = "https://api.jup.ag";

interface JupiterFetchOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
}

export async function jupiterFetch(
  path: string,
  params?: Record<string, string>,
  options?: JupiterFetchOptions
): Promise<unknown> {
  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) {
    throw new Error("JUPITER_API_KEY environment variable is not set");
  }

  const url = new URL(JUPITER_API_BASE + path);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = { "x-api-key": apiKey };
  const init: RequestInit = { headers };

  if (options?.method === 'POST') {
    init.method = 'POST';
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }
  } else {
    init.method = 'GET';
  }

  const response = await fetch(url.toString(), init);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Jupiter API error: ${response.status} ${response.statusText} — ${body}`
    );
  }

  return response.json() as Promise<unknown>;
}
