import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: 'http://127.0.0.1:4173', viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {},
  },
  webServer: { command: 'node e2e/server.mjs', port: 4173, reuseExistingServer: !process.env.CI },
});
