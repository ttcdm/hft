import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * Every Mermaid diagram in the docs must parse with the real Mermaid parser (the version pinned in package.json).
 * GitHub showed "Unable to render rich display" for the trade-lifecycle diagram in docs/ARCHITECTURE.md even though it parsed in every
 * Mermaid version tried locally (10.6 to 12.1), so the cause was never found. Until it is, the diagrams follow a plain house style that
 * avoids what is most often fragile when GitHub renders them: HTML in labels, special node shapes, very long labels, very large blocks.
 * Parsing proves the syntax is valid. It does not prove GitHub renders it; check the page on GitHub after editing a diagram.
 */
function markdownFiles(): string[] {
  try {
    return execSync('git ls-files "*.md"', { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return ['README.md', 'KNOWN_RISKS.md', 'AGENTS.md', ...fs.readdirSync('docs').filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)].filter((f) => fs.existsSync(f));
  }
}

const blocks = markdownFiles().flatMap((file) => {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)].map((m, i) => ({ id: `${file} #${i + 1}`, code: m[1] }));
});

// Mermaid's parser needs a DOM (it sanitises with DOMPurify). A small fake one is enough; nothing is rendered.
async function loadMermaid() {
  const g = globalThis as any;
  if (!g.document) { const w = new Window(); g.window = w; g.document = w.document; }
  return (await import('mermaid')).default;
}

describe('Mermaid diagrams in the docs', () => {
  it('finds the diagrams (so the extraction cannot silently match nothing)', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(3);
  });

  it.each(blocks.map((b) => [b.id, b.code]))('%s parses', async (_id, code) => {
    const mermaid = await loadMermaid();
    await expect(mermaid.parse(code as string)).resolves.toBeTruthy();
  });

  it('the parser really rejects broken syntax (the check is not vacuous)', async () => {
    const mermaid = await loadMermaid();
    await expect(mermaid.parse('flowchart TD\n  a --> --> b')).rejects.toThrow();
  });

  // docs/archive/ is kept as history and not maintained, so it is held to the parser only
  it.each(blocks.filter((b) => !b.id.startsWith('docs/archive/')).map((b) => [b.id, b.code]))('%s follows the plain house style', (_id, code) => {
    const c = code as string;
    expect(c.length, 'block is large; split it into two diagrams').toBeLessThan(6000);
    expect(/<\/?[a-zA-Z][^>]*>/.test(c), 'no HTML tags (<br/> and friends) in diagrams').toBe(false);
    expect(/\[\(|\(\[|\(\(|\[\[|\{\{/.test(c), 'only plain [rectangle] and {decision} node shapes').toBe(false);
    expect(/^\s*note\s/m.test(c), 'no state-diagram notes; put the text in prose').toBe(false);
    for (const label of c.matchAll(/"([^"\n]*)"/g)) expect(label[1].length, `label too long: ${label[1]}`).toBeLessThanOrEqual(100);
    expect([...c].every((ch) => ch.charCodeAt(0) < 128), 'ASCII only').toBe(true);
  });
});
