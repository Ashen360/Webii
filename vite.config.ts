import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev-only: saves calibration recordings POSTed by the app into ./calibration-data/.
 * Recordings hold derived numbers only (fingertip positions, distances), never images.
 */
function calibrationRecorder(): Plugin {
  const dir = resolve(__dirname, 'calibration-data');
  return {
    name: 'webii-calibration-recorder',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__webii/calibration', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return res.end();
        }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 40_000_000) req.destroy();
          else chunks.push(c);
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            mkdirSync(dir, { recursive: true });
            const kind = typeof data.kind === 'string' && /^[a-z]+$/.test(data.kind) ? data.kind : 'calibration';
            const label = typeof data.label === 'string' ? data.label.replace(/[^a-z0-9-]/gi, '').slice(0, 24) : '';
            const name = `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}${label ? `-${label}` : ''}.json`;
            writeFileSync(join(dir, name), JSON.stringify(data));
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ file: `calibration-data/${name}` }));
            server.config.logger.info(`[webii] recording saved → calibration-data/${name}`);
          } catch {
            res.statusCode = 400;
            res.end('bad json');
          }
        });
      });
    },
  };
}

export default defineConfig({
  server: { port: 5178, strictPort: true },
  plugins: [calibrationRecorder()],
  test: { include: ['tests/**/*.test.ts'] },
} as any);
