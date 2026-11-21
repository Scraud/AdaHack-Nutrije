import { expect, test } from '@playwright/test';
import type { State } from '../packages/contracts';

test('offline road map, live positions, restrictions, and the dispatcher approval flow', async ({ page, request }) => {
  await page.route('https://**/*', route => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'Ponastavi demo' }).click();
  await page.getByRole('button', { name: 'Potrdi ponastavitev' }).click();
  await expect(page.getByRole('heading', { name: 'Nadzorna plošča' })).toBeVisible();
  await expect(page.locator('.leaflet-road-base-pane canvas')).toBeVisible();
  await expect(page.locator('.ambulance-pin')).toHaveCount(5);
  await expect(page.locator('.facility-pin')).toHaveCount(4);
  await expect(page.getByRole('row').filter({ hasText: 'T01' })).toBeVisible();
  await page.getByRole('button', { name: 'Generiraj začetni plan' }).click();
  await expect(page.getByText('Aktivni plan v1')).toBeVisible();
  await expect(page.locator('.route-to-pickup').first()).toBeVisible();
  await expect(page.locator('.pickup-pin').first()).toHaveCSS('width', '32px');
  await expect(page.locator('.facility-pin').first()).toHaveCSS('width', '48px');
  await expect(page.locator('.map-eta').filter({ hasText: /Do pacienta · \d+ min/ }).first()).toBeVisible();

  const planned: State = await (await request.get('/api/state')).json();
  const assignment = planned.active_plan!.assignments[0];
  const task = planned.tasks.find(item => item.id === assignment.task_id)!;
  const bar = page.locator(`[data-task-id="${assignment.task_id}"]`);
  const lengths = await bar.evaluate(element => {
    const width = element.getBoundingClientRect().width;
    const laneWidth = element.parentElement!.getBoundingClientRect().width;
    const driving = Array.from(element.querySelectorAll('.driving'), phase => phase.getBoundingClientRect().width)
      .reduce((sum, value) => sum + value, 0);
    return { width, laneWidth, driving };
  });
  const pixelsPerSecond = lengths.laneWidth / planned.horizon;
  expect(lengths.width).toBeCloseTo((assignment.planned_end - assignment.planned_departure) * pixelsPerSecond, 1);
  expect(lengths.driving).toBeCloseTo((assignment.deadhead + assignment.planned_dropoff
    - assignment.planned_pickup - task.pickup_service) * pixelsPerSecond, 1);
  const toHospital = page.locator('.route-to-hospital').first();
  await expect(toHospital).toHaveAttribute('stroke-dasharray', '2 8');
  await page.getByRole('button', { name: 'Predvajaj 300-krat hitreje' }).click();
  const ambulance = page.locator('.ambulance-pin').first();
  const start = await ambulance.getAttribute('style');
  await expect(ambulance).not.toHaveAttribute('style', start!, { timeout: 14_000 });
  await page.getByRole('button', { name: 'Premor', exact: true }).click();
  await page.getByRole('button', { name: 'Premakni', exact: true }).click();
  await expect(page.getByLabel('Simulirani čas 11:20')).toBeVisible();
  await page.getByRole('button', { name: /Simuliraj okvaro V3/ }).click();
  await expect(page.getByText('Vpliv na aktivni plan')).toBeVisible();
  await expect(page.locator('.ambulance-pin[title="Reševalno vozilo V3"] .map-eta')).toBeHidden();
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
  await page.getByLabel('Odsek ceste').selectOption('dunajska');
  await page.getByRole('button', { name: /Simuliraj zastoj/ }).click();
  await expect(page.locator('.road-traffic')).toHaveAttribute('stroke', '#eb2432');
  await page.getByLabel('Odsek ceste').selectOption('smartinska');
  await page.getByRole('button', { name: /Simuliraj zaporo/ }).click();
  await expect(page.locator('.closure-pin')).toBeVisible();
  await expect(page.locator('.road-closure')).toHaveCount(1);
});
