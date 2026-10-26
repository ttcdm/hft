import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { Header } from '../src/components/Header';

describe('R32: the kill-switch tooltip says what the kill switch does', () => {
  it('no longer promises to freeze all loops and open orders', () => {
    const html = renderToStaticMarkup(
      <Header kpis={{} as any} isHalted={false} onToggleKillSwitch={() => undefined} onOpenAiDiagnostics={() => undefined}
        onOpenSystemChecks={() => undefined} onOpenGatewayModal={() => undefined} onOpenAutoPipeline={() => undefined} activeFeed="CME_AURORA" onSelectFeed={() => undefined}
      />
    );
    expect(html).not.toMatch(/freeze all trading loops/i);
    expect(html).toMatch(/Open positions are not sold/);
  });
});
