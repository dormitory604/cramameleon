import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir:'./tests/e2e', workers:1, timeout:30000, reporter:'list',
 use:{baseURL:process.env.TEST_DEPLOYED==='1'?'http://127.0.0.1:18085':'http://127.0.0.1:18086',headless:true,launchOptions:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {}},
 webServer:process.env.TEST_DEPLOYED==='1'?undefined:{command:process.env.TEST_PRODUCTION==='1'?'npx vite preview --host 127.0.0.1 --port 18086':'npm run dev -- --port 18086',url:'http://127.0.0.1:18086',reuseExistingServer:false},
});
