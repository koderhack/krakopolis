import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * ZTP Kraków i Overpass API nie wysyłają nagłówków CORS – przeglądarka nie może
 * pobrać ich bezpośrednio. Dlatego w dev i preview robimy przezroczyste proxy
 * do publicznych, oficjalnych adresów. Nic nie jest pośredniczone przez cudzy serwer.
 */
function dataProxy(): Plugin {
  const ztp = 'https://gtfs.ztp.krakow.pl';
  const overpass = 'https://overpass-api.de';
  const routes: { prefix: string; target: string }[] = [
    { prefix: '/api/live/ztp', target: ztp },
    { prefix: '/api/live/overpass', target: overpass },
  ];
  const middleware = (server: { middlewares: { use: (fn: any) => void } }) => {
    server.middlewares.use(async (req: any, res: any, next: any) => {
      const url: string = req.url ?? '';
      const route = routes.find((r) => url.startsWith(r.prefix));
      if (!route) return next();
      const target = route.target + url.slice(route.prefix.length);
      try {
        const upstream = await fetch(target, {
          method: req.method,
          headers: { 'User-Agent': 'simcity-krakow/0.2 (hackathon prototype)' },
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.statusCode = upstream.status;
        res.end(body);
      } catch (e) {
        res.statusCode = 502;
        res.end(String(e));
      }
    });
  };
  return {
    name: 'simcity-data-proxy',
    configureServer: middleware,
    configurePreviewServer: middleware,
  };
}

export default defineConfig({
  plugins: [react(), dataProxy()],
  server: { host: true, port: 5173 },
  build: { chunkSizeWarningLimit: 8000 },
});