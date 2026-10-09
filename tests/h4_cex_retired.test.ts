import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe('H4: the CEX feeds and fake HFT panels are retired from the browser', () => {
  it('the exchange stream, order book, tape, strategy fleet, PnL engine, stress lab and DMA gateway files are gone', () => {
    for (const f of [
      'src/services/exchangeStream.ts', 'src/components/OrderBook.tsx', 'src/components/ExecutionTape.tsx', 'src/components/StrategyFleet.tsx',
      'src/components/PnLEngine.tsx', 'src/components/NetworkStressLab.tsx', 'src/components/ExchangeGatewayModal.tsx',
    ]) expect(fs.existsSync(f), f).toBe(false);
  });

  it('nothing in src/ names a CEX host, so the page cannot open a Binance/Coinbase/Bybit/OKX/Kraken connection', () => {
    const hits = walk('src')
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => /(binance|bybit|coinbase|okx|kraken)\.(com|us)|stream\.binance|wss?:\/\/[^'"` ]*(binance|bybit|coinbase)/i.test(fs.readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('App no longer imports a deleted module or opens an exchange stream, and the server has no CEX latency-probe route', () => {
    const app = fs.readFileSync('src/App.tsx', 'utf8');
    expect(app).not.toMatch(/exchangeStream|OrderBook|ExecutionTape|StrategyFleet|PnLEngine|NetworkStressLab|ExchangeGatewayModal/);
    expect(fs.readFileSync('server.ts', 'utf8')).not.toContain('/api/latency-probe');
  });
});
