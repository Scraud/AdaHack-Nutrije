import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const python = process.env['RESCUEFLOW_TEST_PYTHON']
  ?? resolve(process.platform === 'win32' ? '../.venv/Scripts/python.exe' : '../.venv/bin/python');

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:14200',
    channel: process.env['RESCUEFLOW_TEST_BROWSER'],
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `"${python}" -m uvicorn app.main:app --host 127.0.0.1 --port 18000`,
      cwd: '../backend',
      env: { RESCUEFLOW_DB: 'playwright.sqlite' },
      url: 'http://127.0.0.1:18000/api/health',
    },
    {
      command: 'node ./node_modules/@angular/cli/bin/ng.js serve --host 127.0.0.1 --port 14200 --proxy-config e2e/proxy.json',
      url: 'http://127.0.0.1:14200',
    },
  ],
});
