// Headless-browser pass: logs in through the UI, clicks every header control and Quant Tools item at each width, screenshots them
// and audits geometry (page/header overflow, off-screen controls, overlapping buttons, clipped text). Set FIXTURE=1 to boot
// scripts/visual/serve_fixture.ts (labelled synthetic board rows) instead of dist/server.cjs. WIDTHS=1280,1440,1920 by default.
// Needs: npm run build, and Playwright + Chromium (PLAYWRIGHT_PATH, CHROMIUM_PATH). Not part of npm test.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const OUT = process.env.OUT || './screens-visual';
fs.mkdirSync(OUT, { recursive: true });
const PORT = 3188, PW = 'visualtest-pw-123456';
const widths = (process.env.WIDTHS || '1280,1440,1920').split(',').map(Number);
const dbp = '/tmp/apex-visual-r3.db'; for (const s of ['', '-shm', '-wal']) try { fs.unlinkSync(dbp + s); } catch {}
const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', APP_PORT: String(PORT), OPERATOR_PASSWORD: PW, APEX_ENV_FILE: '', TEST_DB_PATH: dbp, APEX_DB_PATH: dbp };
const srv = process.env.FIXTURE ? spawn('npx', ['tsx', 'scripts/visual/serve_fixture.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] }) : spawn(process.execPath, ['dist/server.cjs'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
let slog = ''; srv.stdout.on('data', d => slog += d); srv.stderr.on('data', d => slog += d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = [];
// geometry audit run inside the page
const audit = () => {
  const vw = document.documentElement.clientWidth, out = [];
  if (document.documentElement.scrollWidth > vw + 1) out.push(`PAGE h-scroll: scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
  const hdr = document.querySelector('header');
  if (hdr && hdr.scrollWidth > hdr.clientWidth + 1) out.push(`HEADER overflow by ${hdr.scrollWidth - hdr.clientWidth}px`);
  for (const e of document.querySelectorAll('body *')) {
    const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (r.right > vw + 1 && cs.position !== 'fixed' && !e.closest('[class*="overflow-x"], [class*="overflow-auto"], [class*="overflow-hidden"]')) out.push(`OFFSCREEN ${e.tagName}.${String(e.className).slice(0, 50)} right=${Math.round(r.right)} "${(e.innerText || '').slice(0, 30).replace(/\n/g, ' ')}"`);
    if ((cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.textOverflow === 'ellipsis') && e.scrollWidth > e.clientWidth + 2 && e.children.length === 0 && (e.innerText || '').trim()) out.push(`CLIPPED text "${e.innerText.trim().slice(0, 40)}" (${e.scrollWidth}>${e.clientWidth})`);
  }
  // overlap of sibling buttons in header
  const bs = [...document.querySelectorAll('header button')].filter(b => b.offsetWidth).map(b => ({ b, r: b.getBoundingClientRect() }));
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) { const a = bs[i].r, c = bs[j].r; if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) out.push(`OVERLAP "${bs[i].b.innerText.trim().slice(0, 20)}" with "${bs[j].b.innerText.trim().slice(0, 20)}"`); }
  return [...new Set(out)].slice(0, 25);
};
(async () => {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch {} await sleep(500); }
  const login = await (await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) })).json();
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  for (const W of widths) {
    const p = await b.newPage({ viewport: { width: W, height: 900 } });
    const errs = [], bad = [];
    p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
    p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
    p.on('response', r => { if (r.status() >= 400 && r.url().includes('127.0.0.1')) bad.push(`${r.status()} ${r.request().method()} ${r.url().replace(/.*:\d+/, '')}`); });
    await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' }); await p.waitForTimeout(2500);
    // log in through the UI
    if (!(await p.locator('input[type=password]').count())) { await p.locator('#btn-operator-auth').click({ timeout: 4000 }).catch(() => {}); await p.waitForTimeout(500); }
    if (await p.locator('input[type=password]').count()) { await p.locator('input[type=password]').fill(login.token); await p.locator('button[type=submit]').click(); await p.waitForTimeout(1500); }
    await p.reload({ waitUntil: 'load' }); await p.waitForTimeout(3500);
    let n = 0; const shot = async (name, full) => { n++; const f = `${W}-${String(n).padStart(2, '0')}-${name}.png`; await p.screenshot({ path: `${OUT}/${f}`, fullPage: !!full }); return f; };
    const step = async (name, fn) => {
      try { await fn(); } catch (e) { report.push({ W, name, error: String(e).slice(0, 200) }); }
      const a = await p.evaluate(audit); const f = await shot(name);
      report.push({ W, name, file: f, issues: a });
    };
    await step('home', async () => {});
    for (const t of ['launches', 'watching', 'holding']) await step('tab-' + t, async () => { await p.getByTestId('tab-' + t).click({ timeout: 2000 }); await p.waitForTimeout(500); });
    // nav
    for (const id of ['btn-nav-telegram-tracker', 'btn-nav-plug-and-play', 'btn-nav-workstation']) await step(id, async () => { await p.locator('#' + id).click({ timeout: 3000 }); await p.waitForTimeout(1200); });
    // direct header buttons then dropdown items
    const headerIds = ['btn-capital-tier-toggle', 'btn-auto-profit-ticker', 'btn-engine-console', 'btn-open-backtest', 'btn-unit-tests', 'btn-operator-auth', 'btn-deploy-algorithm', 'btn-audio-toggle'];
    const reload = async () => { await p.reload({ waitUntil: 'load' }); await p.waitForTimeout(3000); };
    for (const id of headerIds) {
      const el = p.locator('#' + id);
      if (!(await el.count()) || !(await el.isVisible())) { report.push({ W, name: id, note: 'not visible at this width' }); continue; }
      await step(id, async () => { await el.click({ timeout: 3000 }); await p.waitForTimeout(1000); });
      await reload();
    }
    const dd = p.locator('#btn-quant-tools-dropdown');
    if (await dd.isVisible().catch(() => false)) {
      await step('dropdown-open', async () => { await dd.click(); await p.waitForTimeout(400); });
      const items = await p.locator('#btn-quant-tools-dropdown + div button').evaluateAll(els => els.map(e => e.innerText.trim().replace(/\n/g, ' | ')));
      for (let i = 0; i < items.length; i++) {
        await reload(); await dd.click(); await p.waitForTimeout(300);
        await step('dd-' + items[i].replace(/[^a-z0-9]+/gi, '_').slice(0, 24), async () => { await p.locator('#btn-quant-tools-dropdown + div button').nth(i).click({ timeout: 3000 }); await p.waitForTimeout(1200); });
      }
    } else report.push({ W, name: 'dropdown', note: 'not shown at this width' });
    report.push({ W, name: 'console', errs: [...new Set(errs)], bad: [...new Set(bad)] });
    await p.close();
  }
  fs.writeFileSync('./screens-visual/report.json', JSON.stringify(report, null, 1));
  for (const r of report) console.log(r.W, r.name, r.error || r.note || '', (r.issues || []).length ? '\n   ' + r.issues.join('\n   ') : '', r.errs ? JSON.stringify(r.errs) + JSON.stringify(r.bad) : '');
  await b.close(); srv.kill();
})().catch(e => { console.error('FAIL', e); srv.kill(); process.exit(1); });
