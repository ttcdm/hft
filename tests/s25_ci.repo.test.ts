import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

describe('S25: CI triggers on any branch, reads only, and can be run by hand', () => {
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  it('push runs on every branch, workflow_dispatch exists, permissions are contents: read, and runs on one ref cancel each other', () => {
    expect(ci).toMatch(/push:\s*\n\s*branches: \['\*\*'\]/);
    expect(ci).toMatch(/workflow_dispatch:/);
    expect(ci).toMatch(/permissions:\s*\n\s*contents: read/);
    expect(ci).toMatch(/cancel-in-progress: true/);
  });
});
