import { test, expect } from '@playwright/test';

// Synthetic API fixtures are confined to browser tests; production loads /v1 normally.
const device = (id, status = 'active', online = true) => ({
  id, status, online, patient_ref: `P-${id}`, consent_version: '2026.1', config_version: 2,
  config: { hr_interval_min: 5, history_interval_min: 60 },
  created_at: 1791800000000, last_seen_at: 1791800100000,
});
const initial = [device('BS-001'), device('BS-002', 'pending', false), device('BS-003', 'revoked', false)];

async function setup(page, custom) {
  const requests = [];
  await page.route('**/v1/**', async route => {
    const req = route.request(), url = new URL(req.url());
    requests.push({ path: url.pathname, method: req.method(), body: req.postDataJSON() });
    if (custom && await custom(route, url)) return;
    let data = { data: [] };
    if (url.pathname === '/v1/me') data = { id: 'admin', scopes: ['manage'] };
    else if (url.pathname === '/v1/devices') data = { data: initial, next: null };
    else if (url.pathname.endsWith('/status')) data = { online: true, latest: { state: { connection: 'READY' } } };
    else if (url.pathname.endsWith('/config')) data = { config_version: 3 };
    else if (url.pathname.endsWith('/current')) data = { title: 'Participação', version: '2026.1', content: 'Texto do termo de teste' };
    await route.fulfill({ json: data });
  });
  await page.goto('/admin/');
  await page.locator('#key').fill('synthetic-test-key');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.locator('#app')).toBeVisible();
  return requests;
}

test('selection, live counts, custom icon and commands target the selected installation', async ({ page }) => {
  const requests = await setup(page);
  await expect(page.locator('#installs tr')).toHaveCount(3);
  await expect(page.locator('#totalCount')).toHaveText('03');
  await expect(page.locator('#onlineCount')).toHaveText('01');
  await expect(page.locator('#pendingCount')).toHaveText('01');
  await expect(page.locator('#revokedCount')).toHaveText('01');
  await page.getByRole('button', { name: 'Selecionar BIOSENSE Pulse BS-002', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#deviceDetail')).toContainText('P-BS-002');
  await expect(page.getByRole('button', { name: 'Autorizar instalação' })).toBeVisible();
  await page.getByRole('button', { name: 'Selecionar BIOSENSE Pulse BS-001', exact: true }).click();
  await expect.poll(() => page.locator('#deviceDetail img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  await page.getByRole('button', { name: 'Comandos', exact: true }).click();
  await expect(page.locator('#cmdLive')).toContainText('Celular conectado');
  await page.getByRole('button', { name: 'Vibrar agora' }).click();
  await expect.poll(() => requests.find(r => r.method === 'POST' && r.path.endsWith('/commands'))).toEqual({
    path: '/v1/devices/BS-001/commands', method: 'POST', body: { type: 'vibrate', params: { count: 2, level: 'high' }, ttl_s: 60 },
  });
  await page.locator('#cmdDialog').getByRole('button', { name: 'Fechar' }).click();
  await expect(page.locator('#cmdDialog')).not.toBeVisible();
});

test('config, consent history and authorization preserve API contracts', async ({ page }) => {
  const requests = await setup(page);
  await page.getByRole('button', { name: 'Configurar coleta' }).click();
  await page.locator('#cfgHr').selectOption('15');
  await page.locator('#cfgSave').click();
  await expect.poll(() => requests.find(r => r.method === 'PUT')).toEqual({ path: '/v1/devices/BS-001/config', method: 'PUT', body: { hr_interval_min: 15, history_interval_min: 60 } });
  await page.getByRole('button', { name: 'Consultar histórico' }).click();
  await expect(page.locator('#consDialog')).toBeVisible();
  await page.locator('#consDialog').getByRole('button', { name: 'Fechar' }).click();
  await page.getByRole('button', { name: 'Selecionar BIOSENSE Pulse BS-002', exact: true }).click();
  page.once('dialog', dialog => dialog.accept('P-204'));
  await page.getByRole('button', { name: 'Autorizar instalação' }).click();
  await expect.poll(() => requests.find(r => r.path.endsWith('/authorize'))).toEqual({ path: '/v1/devices/BS-002/authorize', method: 'POST', body: { participant_ref: 'P-204' } });
});

test('filters, pagination, empty state and untrusted participant text', async ({ page }) => {
  await setup(page, async (route, url) => {
    if (url.pathname !== '/v1/devices') return false;
    const data = url.searchParams.has('q') ? [] : url.searchParams.has('cursor') ? [device('BS-002')] : [{ ...device('BS-001'), patient_ref: '<img src=x onerror=alert(1)>' }];
    await route.fulfill({ json: { data, next: url.searchParams.size === 1 ? 'BS-001' : null } });
    return true;
  });
  await expect(page.locator('#deviceDetail')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#deviceDetail img')).toHaveCount(1);
  await page.locator('#loadMore').click();
  await expect(page.locator('#installs tr')).toHaveCount(2);
  await page.locator('#fQ').fill('missing');
  await page.locator('#fQ').press('Enter');
  await expect(page.locator('#installs tr')).toHaveCount(0);
  await expect(page.locator('#installsEmpty')).toContainText('Nenhuma instalação');
  await expect(page.locator('#totalCount')).toHaveText('00');
  await expect(page.locator('#deviceDetail')).toContainText('Selecione uma instalação');
});

test('failed refresh preserves data and shows error; session expiry closes dialogs', async ({ page }) => {
  let fail = false, expire = false;
  await setup(page, async (route, url) => {
    if (url.pathname !== '/v1/devices' || !fail) return false;
    await route.fulfill({ status: expire ? 401 : 503, json: { message: 'Serviço indisponível' } });
    return true;
  });
  await expect(page.locator('#installs tr')).toHaveCount(3);
  fail = true;
  await page.locator('#reload').click();
  await expect(page.locator('#updatedAt')).toContainText('Falha ao atualizar');
  await expect(page.locator('#installs tr')).toHaveCount(3);
  expire = true;
  await page.locator('#reload').click();
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#app')).not.toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('biosense.admin.key'))).toBeNull();
});

test('late responses cannot overwrite a newer filter or restore logged-out data', async ({ page }) => {
  let held;
  await setup(page, async (route, url) => {
    if (url.pathname === '/v1/devices' && url.searchParams.get('q') === 'slow') { held = route; return true; }
    if (url.pathname === '/v1/devices' && url.searchParams.get('status') === 'pending') {
      await route.fulfill({ json: { data: [initial[1]], next: null } }); return true;
    }
    return false;
  });
  await page.locator('#fQ').fill('slow');
  await page.locator('#fQ').press('Enter');
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.locator('#fQ').fill('');
  await page.locator('#fStatus').selectOption('pending');
  await expect(page.locator('#installs tr')).toHaveCount(1);
  await held.fulfill({ json: { data: initial, next: null } });
  await expect(page.locator('#deviceDetail')).toContainText('P-BS-002');
  await page.locator('#logout').click();
  await expect(page.locator('#installs tr')).toHaveCount(0);
});

test('desktop and mobile layouts, navigation and no runtime errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await setup(page);
  await expect(page.locator('#installs tr')).toHaveCount(3);
  await page.screenshot({ path: 'test-results/admin-desktop.png', fullPage: true });
  for (const tab of ['terms', 'techs', 'alerts', 'installs']) {
    await page.locator(`[data-tab="${tab}"]`).click();
    await expect(page.locator(`[data-panel="${tab}"]`)).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/admin-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Configurar coleta' }).click();
  await expect(page.locator('#cfgDialog')).toBeVisible();
  expect(errors).toEqual([]);
});
