import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfluenceThresholdEditor } from '../src/components/AutoPanel';
import { autoSnipeController } from '../server/auto/controller';
import { getConfluenceThreshold, resetConfluenceThreshold } from '../server/signals/confluenceThreshold';
import { workstationDb } from '../server/db/database';

/** R9-9: the threshold note said "Kept until the server restarts", but the threshold is saved and comes back at start. */
describe('R9-9: the threshold note says it survives a restart, because it does', () => {
  afterEach(() => { resetConfluenceThreshold(); workstationDb.setSetting('auto.confluenceThreshold', null); workstationDb.setSetting('auto.kill', null); });

  it('the server keeps an operator threshold across restorePersisted', async () => {
    expect(autoSnipeController.setConfluenceThreshold(40).ok).toBe(true);
    resetConfluenceThreshold(); // what a fresh process starts with
    const r = await autoSnipeController.restorePersisted();
    expect(r.threshold).toBe(40);
    expect(getConfluenceThreshold()).toBe(40);
  });

  it('the panel does not say it is lost on restart', () => {
    const html = renderToStaticMarkup(<ConfluenceThresholdEditor confluence={{ value: 40, defaultValue: 70, source: 'operator', warnBelow: 50, warning: null }} />);
    expect(html).not.toMatch(/until the server restarts/);
    expect(html).toMatch(/a restart keeps it/);
  });
});
