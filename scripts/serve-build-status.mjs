import http from 'node:http';
import {readFile, realpath} from 'node:fs/promises';
import {resolve, relative, isAbsolute, extname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = new Set(['build-status.html','status/build-status.css','status/build-status.js','status/build-status-data.js','status/build-status-view.json']);
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.md':'text/plain; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};

export function createTrackerServer() {
  return http.createServer(async (request, response) => {
    response.setHeader('Cache-Control','no-store');
    response.setHeader('X-Content-Type-Options','nosniff');
    if (!['GET','HEAD'].includes(request.method)) {
      response.writeHead(405, {Allow:'GET, HEAD'});response.end();return;
    }
    try {
      const name = decodeURIComponent(new URL(request.url,'http://localhost').pathname).slice(1) || 'build-status.html';
      if (name === '_tracker/health') {
        response.writeHead(200, {'Content-Type':'application/json'});
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify({service:'lara-build-tracker'}));return;
      }
      const allowed = files.has(name) ||
        /^docs\/development\/[a-zA-Z0-9/_-]+\.md$/.test(name) ||
        /^images\/branding\/ledger-l\/web\/[a-zA-Z0-9/_-]+\.(css|svg|png|ico)$/.test(name);
      if (!allowed) {response.writeHead(404);response.end('Not found');return;}
      const base = await realpath(root);
      const target = await realpath(resolve(base,name));
      const inside = relative(base,target);
      if (inside.startsWith('..') || isAbsolute(inside)) {response.writeHead(404);response.end('Not found');return;}
      const body = await readFile(target);
      response.writeHead(200, {'Content-Type':types[extname(name)],'Content-Length':body.length});
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {response.writeHead(404);response.end('Not found');}
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.LARA_TRACKER_PORT || 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid LARA_TRACKER_PORT');
  createTrackerServer().listen(port,'127.0.0.1',()=>console.log('LARA build tracker: http://127.0.0.1:'+port+'/build-status.html'));
}
