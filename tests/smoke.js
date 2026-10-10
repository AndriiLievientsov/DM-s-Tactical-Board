// Smoke test: loads index.html in headless Chromium and checks the core flows.
// Run: npm i --no-save playwright && npx playwright install chromium && node tests/smoke.js
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 800 }, hasTouch: true });
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL);

  // XSS: location names must be escaped
  await page.evaluate((png) => {
    const loc = getCurrentLocation();
    loc.name = '<img src=x onerror=window.__xss=1>';
    loc.tokens.push({ id: 1, src: png, x: 200, y: 200, radius: 25, name: 'Гоблин', hp: 5, maxHp: 7, rotation: 0 });
    pushHistory(); renderLocations(); drawCanvas();
  }, PNG);
  assert.strictEqual(await page.evaluate(() => !!window.__xss), false, 'XSS executed');

  // AoE template via hotkey + drag
  await page.keyboard.press('t');
  await page.mouse.move(500, 300); await page.mouse.down(); await page.mouse.move(700, 350, { steps: 5 }); await page.mouse.up();
  assert.ok(await page.evaluate(() => state.currentMode === 'template' && !!state.tplStart), 'template not placed');
  await page.keyboard.press('Escape');

  // Undo restores token images
  await page.evaluate(() => { getCurrentLocation().tokens[0].x = 300; pushHistory(); undo(); });
  assert.strictEqual(await page.evaluate(() => getCurrentLocation().tokens[0].x), 200);
  assert.ok(await page.evaluate(() => getCurrentLocation().tokens[0].src.startsWith('data:')), 'token image lost on undo');

  // History is reset when switching locations
  await page.evaluate(() => { addLocation('B'); setCurrentLocationId(state.adventureData.locations[1].id); });
  assert.strictEqual(await page.evaluate(() => state.drawingHistory.length), 1);

  // Import validation: bad data throws and keeps the session; minimal data is normalised
  const kept = await page.evaluate(() => { const n = state.adventureData.locations.length; try { applyAdventure({ locations: [] }); } catch (e) { return n === state.adventureData.locations.length; } return false; });
  assert.ok(kept, 'bad import wiped the session');
  await page.evaluate(() => applyAdventure({ locations: [{ id: 5, name: 'x' }] }));
  assert.deepStrictEqual(await page.evaluate(() => getCurrentLocation().tokens), []);

  // Status durations tick down on the token's turn and expire
  const dur = await page.evaluate((png) => {
    const l = getCurrentLocation();
    l.tokens.push({ id: 77, src: png, x: 100, y: 100, radius: 25, name: 'Маг', rotation: 0, statuses: ['🔥', '🛡️'], statusRounds: { '🔥': 2 } });
    state.initiative = { combatants: [{ id: 1, name: 'Маг', init: 10, hp: '', tokenRef: 77 }], currentIndex: 0, round: 1 };
    const next = () => document.getElementById('init-next-btn').click();
    next(); const after1 = JSON.stringify(l.tokens.find(t => t.id === 77).statuses);
    next(); const t = l.tokens.find(t => t.id === 77);
    return { after1, after2: JSON.stringify(t.statuses), rounds: JSON.stringify(t.statusRounds) };
  }, PNG);
  assert.deepStrictEqual(dur, { after1: '["🔥","🛡️"]', after2: '["🛡️"]', rounds: '{}' });

  // Hex grid: snapping lands on hex centres, ruler counts hexes, setting is per location
  const hex = await page.evaluate(() => {
    document.getElementById('grid-type-toggle').click();
    const snapped = snapToGrid(37, 41);
    const back = pixelToHex(snapped.x, snapped.y), c = hexToPixel(back.q, back.r);
    const d = hexDistance(pixelToHex(0, 0), pixelToHex(hexToPixel(3, -1).x, hexToPixel(3, -1).y));
    drawCanvas();
    return { onCentre: Math.abs(c.x - snapped.x) < 1e-9 && Math.abs(c.y - snapped.y) < 1e-9, d, saved: getCurrentLocation().gridType };
  });
  assert.deepStrictEqual(hex, { onCentre: true, d: 3, saved: 'hex' });
  await page.evaluate(() => document.getElementById('grid-type-toggle').click());

  // Autosave + recovery slot
  await page.evaluate(() => { state.adventureData.notes = 'secret'; markDirty(); });
  await page.waitForTimeout(2600);
  assert.match(await page.textContent('#save-status'), /Автосохранено/);
  await page.reload(); await page.waitForTimeout(800);
  assert.strictEqual(await page.locator('#recover-autosave-btn').count(), 1, 'recovery button missing');

  // Player window mirrors state but not hidden fog
  const p2 = await ctx.newPage();
  p2.on('pageerror', e => errors.push('player: ' + e.message));
  await p2.goto(URL + '?player=1'); await p2.waitForTimeout(300);
  await page.evaluate((png) => {
    const l = getCurrentLocation();
    l.tokens.push({ id: 9, src: png, x: 60, y: 60, radius: 25, name: 'Орк', hp: 3, maxHp: 9, rotation: 0 });
    l.fog.push({ id: 1, type: 'rect', hidden: true, color: '#000000', opacity: 1, points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }] });
    pushHistory(); drawCanvas();
  }, PNG);
  await p2.waitForTimeout(500);
  const pl = await p2.evaluate(() => ({ tokens: getCurrentLocation().tokens.length, fog: getCurrentLocation().fog.length }));
  assert.deepStrictEqual(pl, { tokens: 1, fog: 0 });

  // Pinch zoom
  const cdp = await ctx.newCDPSession(page);
  const z0 = await page.evaluate(() => state.zoomLevel);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 500, y: 300, id: 1 }, { x: 600, y: 300, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 400, y: 300, id: 1 }, { x: 700, y: 300, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.ok(await page.evaluate(() => state.zoomLevel) > z0, 'pinch did not zoom');

  assert.deepStrictEqual(errors, [], 'console/page errors: ' + errors.join('; '));
  await browser.close();
  console.log('smoke test passed');
})().catch(e => { console.error(e); process.exit(1); });
