/** Health – potwierdzenie, że Pages Functions działają (zamiast osobnego API Mikrus). */
export async function onRequest(): Promise<Response> {
  return Response.json({
    ok: true,
    service: 'simcity-krakow',
    storage: 'indexeddb',
    ts: new Date().toISOString(),
  });
}
