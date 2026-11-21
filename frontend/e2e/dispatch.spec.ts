import { expect, test } from '@playwright/test';

test('reset, breakdown, distinct proposals, preview, approval and history with offline map tiles', async ({ page, request }) => {
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'Ponastavi demo' }).click();
  await page.getByRole('button', { name: 'Potrdi ponastavitev' }).click();
  await expect(page.getByRole('heading', { name: 'Nadzorna plošča' })).toBeVisible();
  await expect(page.getByText('Zemljevidne ploščice niso dosegljive.', { exact: false })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'T01' })).toBeVisible();
  await page.getByRole('button', { name: 'Generiraj začetni plan' }).click();
  await expect(page.getByText('Aktivni plan v1')).toBeVisible();
  await page.getByRole('button', { name: 'Premakni', exact: true }).click();
  await expect(page.getByLabel('Simulirani čas 11:20')).toBeVisible();
  await page.getByRole('button', { name: /Simuliraj okvaro V3/ }).click();
  await expect(page.getByText('Vpliv na aktivni plan')).toBeVisible();
  await page.getByRole('button', { name: 'Generiraj predloge' }).click();
  const recommendations = page.locator('.recommendation');
  await expect(recommendations.nth(1)).toBeVisible();
  const first = recommendations.first();
  await first.getByRole('button', { name: 'Predogled' }).click();
  await expect(page.getByText('Predogled kandidatnega plana')).toBeVisible();
  expect((await (await request.get('/api/state')).json()).active_plan.version).toBe(1);
  await first.getByRole('button', { name: 'Potrdi predlog' }).click();
  await expect(page.getByText('Aktivni plan v2')).toBeVisible();
  await page.getByRole('button', { name: /Verzija 1/ }).click();
  await expect(page.getByText('Pregled verzije 1')).toBeVisible();
});
