import {defineConfig} from '@playwright/test';
export default defineConfig({
 testDir:'./tests/browser', use:{baseURL:'http://127.0.0.1:3015',browserName:'chromium'},outputDir:'.local/browser-results',
 webServer:{command:'node apps/web/node_modules/next/dist/bin/next start apps/web --hostname 127.0.0.1 --port 3015',url:'http://127.0.0.1:3015',reuseExistingServer:false,
 env:{OIDC_ISSUER:'https://identity.invalid',OIDC_CLIENT_ID:'browser-fixture',OIDC_CLIENT_SECRET:'browser-fixture',OIDC_REDIRECT_URI:'http://127.0.0.1:3015/auth/callback',SESSION_SECRET:'browser-fixture-session-key-32-characters'}},
});
