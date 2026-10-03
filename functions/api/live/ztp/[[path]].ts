/**
 * Proxy CORS dla ZTP Kraków na Cloudflare Pages Functions.
 * Frontend woła /api/live/ztp/... → tutaj → https://gtfs.ztp.krakow.pl/...
 */
type Ctx = {
  request: Request;
  params: { path?: string | string[] };
};

export async function onRequest(context: Ctx): Promise<Response> {
  const parts = context.params.path;
  const path = Array.isArray(parts) ? parts.join('/') : (parts ?? '');
  const url = `https://gtfs.ztp.krakow.pl/${path}`;
  try {
    const upstream = await fetch(url, {
      method: context.request.method,
      headers: { 'User-Agent': 'simcity-krakow/0.2 (hackathon; pages proxy)' },
    });
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=10',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
