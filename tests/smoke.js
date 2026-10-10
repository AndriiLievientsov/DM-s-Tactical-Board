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

  // First launch shows the help guide; closing it remembers that
  assert.ok(await page.isVisible('#help-overlay'), 'help not shown on first launch');
  assert.ok((await page.textContent('#help-keys')).includes('Стены и двери'));
  await page.click('#help-close');
  assert.ok(!(await page.isVisible('#help-overlay')), 'help did not close');
  await page.keyboard.press('?');
  assert.ok(await page.isVisible('#help-overlay'), '? does not open help');
  await page.keyboard.press('Escape');
  assert.ok(!(await page.isVisible('#help-overlay')), 'Esc does not close help');

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

  // Stat block: AC/attacks are edited in the props panel, an attack rolls to-hit and damage
  const sb = await page.evaluate(() => {
    openPropsForToken(77);
    const ac = document.getElementById('prop-ac'); ac.value = '15'; ac.dispatchEvent(new Event('change'));
    document.getElementById('sb-add-attack').click();
    const row = document.querySelector('#sb-attacks .sb-attack');
    const set = (cls, v) => { const i = row.querySelector(cls); i.value = v; i.dispatchEvent(new Event('change')); };
    set('.sb-name', 'Скимитар'); set('.sb-bonus', '+4'); set('.sb-dmg', '1d6+2');
    const t = getCurrentLocation().tokens.find(t => t.id === 77);
    document.activeElement.blur();
    const r = rollAttack(t, t.attacks[0]);
    const okHit = r.hit === r.d20 + 4, okDmg = r.damage >= (r.crit ? 4 : 3) && r.damage <= (r.crit ? 14 : 8);
    return { ac: t.ac, atk: JSON.stringify(t.attacks), okHit, okDmg, crit: critFormula('1d8+2d6+3'),
             log: document.getElementById('sb-roll-log').textContent.includes('Скимитар') };
  });
  assert.deepStrictEqual(sb, { ac: 15, atk: '[{"name":"Скимитар","bonus":4,"damage":"1d6+2"}]', okHit: true, okDmg: true, crit: '2d8+4d6+3', log: true });
  // Walls block light; an open door lets it through; walls are drawn by clicks in walls mode
  const light = await page.evaluate(() => {
    const loc = getCurrentLocation();
    loc.walls = [{ id: 1, points: [{ x: 150, y: 0 }, { x: 150, y: 200 }], door: false, open: false }];
    const rightmost = () => visibilityPolygon(100, 100, 300, blockingSegments(loc)).find(p => p.x > 100 && Math.abs(p.y - 100) < 1e-6).x;   // the ray at angle 0
    const blocked = rightmost();
    loc.walls[0].door = true; loc.walls[0].open = true;
    const open = rightmost();
    loc.lighting = 'dark'; drawCanvas();
    return { blocked: Math.round(blocked), open: Math.round(open) };
  });
  assert.deepStrictEqual(light, { blocked: 150, open: 400 });
  // Polygon vertices must go around in angle order (mixed angle ranges once produced dark wedges)
  assert.ok(await page.evaluate(() => {
    const segs = [[{ x: 350, y: 50 }, { x: 350, y: 175 }], [{ x: 350, y: 275 }, { x: 350, y: 400 }]];
    const a = visibilityPolygon(175, 225, 400, segs).map(p => Math.atan2(p.y - 225, p.x - 175));
    return a.every((v, i) => i === 0 || v >= a[i - 1] - 1e-3);
  }), 'visibility polygon out of order');
  // Line of sight & darkvision: pixel behind a wall is hidden from players, in front of it is visible
  const sight = await page.evaluate(async () => {
    const loc = getCurrentLocation();
    const saved = { walls: loc.walls, tokens: loc.tokens, bg: loc.bgData, z: state.zoomLevel, ox: state.offsetX, oy: state.offsetY };
    loc.bgData = null; loc.lighting = 'off'; loc.vision = true;
    loc.walls = [{ id: 9, points: [{ x: 300, y: -1000 }, { x: 300, y: 1000 }], door: false, open: false }];
    loc.tokens = [{ id: 501, src: '', x: 100, y: 100, radius: 10, name: '', rotation: 0, statuses: [], pc: true, darkvision: 60 }];
    state.zoomLevel = 1; state.offsetX = 0; state.offsetY = 0; state.dmDarkAlpha = 0.9;
    await drawCanvas();
    const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)).reduce((a, b) => a + b, 0);
    const front = px(200, 300), behind = px(400, 300);
    loc.vision = false; loc.walls = []; loc.lighting = 'dark'; await drawCanvas();
    const inDarkvision = px(150, 150), outside = px(900, 600);
    loc.lighting = 'off';
    Object.assign(loc, { walls: saved.walls, tokens: saved.tokens, bgData: saved.bg });
    Object.assign(state, { zoomLevel: saved.z, offsetX: saved.ox, offsetY: saved.oy, dmDarkAlpha: 0.6 });
    return { hidesBehindWall: behind < front, darkvisionReveals: inDarkvision > outside };
  });
  assert.deepStrictEqual(sight, { hidesBehindWall: true, darkvisionReveals: true });

  await page.keyboard.press('w');
  await page.mouse.click(600, 300); await page.mouse.click(700, 300); await page.keyboard.press('Enter');
  assert.strictEqual(await page.evaluate(() => getCurrentLocation().walls.length), 2, 'wall not drawn by clicks');
  await page.keyboard.press('h');

  // Group damage/healing: applies to all selected tokens, heal is capped, 0 HP = dead and skipped in initiative
  const grp = await page.evaluate((png) => {
    const l = getCurrentLocation();
    l.tokens.push({ id: 81, src: png, x: 400, y: 100, radius: 25, name: 'Орк1', hp: 10, maxHp: 15, rotation: 0 },
                  { id: 82, src: png, x: 450, y: 100, radius: 25, name: 'Орк2', hp: 4, maxHp: 15, rotation: 0 });
    state.selectedTokenIds = new Set([81, 82]);
    document.getElementById('btn-hp-group').click();
    document.getElementById('hp-amount').value = '6';
    document.getElementById('hp-dmg-btn').click();
    const a = l.tokens.find(t => t.id === 81), b = l.tokens.find(t => t.id === 82);
    const afterDmg = [a.hp, b.hp, isTokenDead(a), isTokenDead(b)];
    state.selectedTokenIds = new Set([81]);
    document.getElementById('hp-amount').value = '20';
    document.getElementById('hp-heal-btn').click();
    state.initiative = { combatants: [{ name: 'Орк1', init: 15, tokenRef: 81 }, { name: 'Орк2', init: 12, tokenRef: 82 }, { name: 'Маг', init: 5, tokenRef: 77 }], currentIndex: 0, round: 1 };
    document.getElementById('init-next-btn').click();
    const skipped = state.initiative.currentIndex;
    state.selectedTokenIds = new Set(); state.initiative = { combatants: [], currentIndex: -1, round: 1 };
    return { afterDmg, healed: a.hp, skipped };
  }, PNG);
  assert.deepStrictEqual(grp, { afterDmg: [4, 0, false, true], healed: 15, skipped: 2 });

  // Movement: dragging shows distance; feet moved this turn add up and reset when the token's turn starts
  const mv = await page.evaluate(() => {
    state.isGridEnabled = true; state.gridType = 'square'; state.cellSize = 50;
    const diag = moveDistanceFt({ x: 25, y: 25 }, { x: 125, y: 75 });   // 2 across, 1 down = 2 cells
    return { diag };
  });
  assert.deepStrictEqual(mv, { diag: 10 });
  await page.evaluate((png) => {
    const l = getCurrentLocation();
    l.tokens.push({ id: 91, src: png, x: 50, y: 50, radius: 25, name: 'Воин', rotation: 0, speed: 30 });
    state.initiative = { combatants: [{ name: 'Воин', init: 10, tokenRef: 91 }], currentIndex: 0, round: 1 };
  }, PNG);
  await page.keyboard.press('h');
  const toScreen = (x, y) => page.evaluate(([x, y]) => { const r = canvas.getBoundingClientRect(); return { x: r.left + x * state.zoomLevel + state.offsetX, y: r.top + y * state.zoomLevel + state.offsetY }; }, [x, y]);
  const drag = async (x1, y1, x2, y2) => {
    const a = await toScreen(x1, y1), b = await toScreen(x2, y2);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up();
  };
  await drag(50, 50, 200, 50);   // 3 cells
  await drag(200, 50, 200, 150); // 2 cells
  const used = await page.evaluate(() => { const u = state.moveUsed[91]; document.getElementById('init-next-btn').click(); return [u, state.moveUsed[91]]; });
  assert.deepStrictEqual(used, [25, undefined]);
  await page.evaluate(() => { state.initiative = { combatants: [], currentIndex: -1, round: 1 }; });

  // Token context menu: header shows stats, duplicate numbers the name, z-order moves the token
  const menu = await page.evaluate((png) => {
    const l = getCurrentLocation();
    l.tokens.push({ id: 95, src: png, x: 600, y: 400, radius: 25, name: 'Гоблин', hp: 3, maxHp: 7, ac: 15, rotation: 0 });
    state.menuTargetTokenIndex = l.tokens.length - 1;
    fillTokenMenuHead(l.tokens[l.tokens.length - 1]);
    const head = document.getElementById('token-menu-head').textContent;
    const c1 = duplicateMenuToken();
    state.menuTargetTokenIndex = l.tokens.indexOf(c1);
    const c2 = duplicateMenuToken();
    state.menuTargetTokenIndex = l.tokens.indexOf(c2);
    document.querySelector('#token-menu [data-action="token-back"]').click();
    const r = { head, names: [c1.name, c2.name], hp: c1.hp, back: l.tokens[0].id === c2.id };
    l.tokens = l.tokens.filter(t => ![95, c1.id, c2.id].includes(t.id));
    return r;
  }, PNG);
  assert.deepStrictEqual(menu, { head: 'Гоблин❤️ 3/7  ·  🛡 КД 15', names: ['Гоблин 2', 'Гоблин 3'], hp: 7, back: true });

  // Layers: objects draw under creatures, can't be grabbed while locked, and skip initiative import
  const lay = await page.evaluate((png) => {
    const l = getCurrentLocation();
    l.tokens.push({ id: 97, src: png, x: 700, y: 500, radius: 25, name: 'Сундук', rotation: 0 },
                  { id: 98, src: png, x: 700, y: 500, radius: 25, name: 'Вор', rotation: 0 });
    // the chest is last in the array, but on the object layer it goes under the thief
    l.tokens.push(l.tokens.splice(l.tokens.findIndex(t => t.id === 97), 1)[0]);
    openPropsForToken(97);
    document.querySelector('#prop-layer [data-layer="object"]').click();
    const ord = layerOrder(l.tokens), order = [ord[0].name, ord[ord.length - 1].name];
    const sx = 700 * state.zoomLevel + state.offsetX, sy = 500 * state.zoomLevel + state.offsetY;
    const top = l.tokens[tokenIndexAt(l, sx, sy, true)].name;
    l.tokens = l.tokens.filter(t => t.id !== 98);
    const lockedMiss = tokenIndexAt(l, sx, sy, true);
    document.getElementById('btn-lock-objects').click();
    const unlockedHit = l.tokens[tokenIndexAt(l, sx, sy, true)].name;
    document.getElementById('btn-lock-objects').click();
    state.initiative = { combatants: [], currentIndex: -1, round: 1 };
    document.getElementById('init-import-btn').click();
    const inInit = state.initiative.combatants.some(c => c.tokenRef === 97);
    state.initiative = { combatants: [], currentIndex: -1, round: 1 };
    l.tokens = l.tokens.filter(t => t.id !== 97);
    return { order, top, lockedMiss, unlockedHit, inInit };
  }, PNG);
  assert.deepStrictEqual(lay, { order: ['Сундук', 'Вор'], top: 'Вор', lockedMiss: -1, unlockedHit: 'Сундук', inInit: false });

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
  await page.evaluate(() => { const l = getCurrentLocation(); l.walls = [{ id: 5, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }]; l.lighting = 'dark'; drawCanvas(); });
  await p2.waitForTimeout(400);
  assert.deepStrictEqual(await p2.evaluate(() => [getCurrentLocation().walls.length, getCurrentLocation().lighting]), [1, 'dark']);
  // Hidden tokens stay on the DM's map but never reach the player window; the menu toggles them back
  await page.evaluate(() => {
    const l = getCurrentLocation();
    state.menuTargetTokenIndex = l.tokens.findIndex(t => t.id === 9);
    fillTokenMenuHead(l.tokens[state.menuTargetTokenIndex]);
    document.querySelector('#token-menu [data-action="toggle-hidden"]').click();
  });
  await p2.waitForTimeout(400);
  assert.deepStrictEqual(await p2.evaluate(() => getCurrentLocation().tokens.length), 0, 'hidden token reached players');
  await page.evaluate(() => { openPropsForToken(9); const c = document.getElementById('prop-hidden'); c.checked = false; c.dispatchEvent(new Event('change')); });
  await p2.waitForTimeout(400);
  assert.deepStrictEqual(await p2.evaluate(() => getCurrentLocation().tokens.length), 1, 'unhidden token missing for players');
  // Dice rolls reach the player window only when sharing is on
  await page.evaluate(() => recordRoll('secret', 13, ''));
  await p2.waitForTimeout(300);
  assert.ok(!(await p2.evaluate(() => document.getElementById('player-roll').classList.contains('show'))), 'unshared roll shown to players');
  await page.evaluate(() => { const c = document.getElementById('dice-share'); c.checked = true; c.dispatchEvent(new Event('change')); recordRoll('d20', 17, 'd20:[17]=17'); });
  await p2.waitForTimeout(300);
  assert.deepStrictEqual(await p2.evaluate(() => [document.getElementById('player-roll').classList.contains('show'), document.querySelector('#player-roll .pr-total').textContent]), [true, '17']);
  await page.evaluate(() => { const c = document.getElementById('dice-share'); c.checked = false; c.dispatchEvent(new Event('change')); });

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
