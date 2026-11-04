import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir:'./tests/live',workers:1,timeout:180000,reporter:'list',
 use:{baseURL:'http://127.0.0.1:18085',headless:true,launchOptions:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}},
});
