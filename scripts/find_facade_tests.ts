/**
 * Reports test cases that never reference a symbol imported from production code (server/ or src/).
 * Such tests only exercise their own local logic or the file system, which AGENTS.md rule 4 forbids.
 *
 * Usage: npx tsx scripts/find_facade_tests.ts [path ...]   (default: tests/)
 * Exit code 1 when any facade test is found.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

export interface FacadeFinding {
  file: string;
  line: number;
  title: string;
}

const TEST_CALLEES = new Set(['it', 'test']);

function isProductionSpecifier(spec: string): boolean {
  return /(^|\/)(server|src)(\/|$)/.test(spec) && !spec.includes('node_modules') && spec.startsWith('.');
}

function collectTestFiles(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) return target.endsWith('.test.ts') ? [target] : [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...collectTestFiles(full));
    else if (entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const base = expr.expression.text;
    const prop = expr.name.text;
    // it.skip / it.only / it.each(...)(...) / it.skipIf(...)(...)
    if (TEST_CALLEES.has(base)) return base;
    return `${base}.${prop}`;
  }
  if (ts.isCallExpression(expr)) return calleeName(expr.expression);
  return undefined;
}

export function findFacadeTests(files: string[]): FacadeFinding[] {
  const findings: FacadeFinding[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

    const productionNames = new Set<string>();
    sf.forEachChild((node) => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
      if (!isProductionSpecifier(node.moduleSpecifier.text)) return;
      const clause = node.importClause;
      if (!clause) return;
      if (clause.name) productionNames.add(clause.name.text);
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) productionNames.add(nb.name.text);
      if (nb && ts.isNamedImports(nb)) nb.elements.forEach((e) => productionNames.add(e.name.text));
    });

    // Names bound by dynamic production imports inside the file: const { x } = await import('../server/...')
    const visitDynamic = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        isProductionSpecifier(node.arguments[0].text)
      ) {
        let parent: ts.Node | undefined = node.parent;
        while (parent && !ts.isVariableDeclaration(parent) && !ts.isStatement(parent)) parent = parent.parent;
        if (parent && ts.isVariableDeclaration(parent)) {
          const name = parent.name;
          if (ts.isIdentifier(name)) productionNames.add(name.text);
          else if (ts.isObjectBindingPattern(name)) name.elements.forEach((e) => ts.isIdentifier(e.name) && productionNames.add(e.name.text));
        }
      }
      ts.forEachChild(node, visitDynamic);
    };
    visitDynamic(sf);

    // Taint propagation: a variable or function is "production-backed" when its initializer, any assignment to it,
    // or its body references a production name (directly or through another production-backed name).
    // This lets tests use setup done in beforeEach/describe scope, e.g. `let coordinator; beforeEach(() => { coordinator = new ExecutionCoordinator(); })`.
    const referencesAny = (node: ts.Node, names: Set<string>): boolean => {
      let hit = false;
      const walk = (n: ts.Node) => {
        if (hit) return;
        if (ts.isIdentifier(n) && names.has(n.text)) {
          hit = true;
          return;
        }
        if (
          ts.isCallExpression(n) &&
          n.expression.kind === ts.SyntaxKind.ImportKeyword &&
          n.arguments.length > 0 &&
          ts.isStringLiteralLike(n.arguments[0]) &&
          isProductionSpecifier(n.arguments[0].text)
        ) {
          hit = true;
          return;
        }
        ts.forEachChild(n, walk);
      };
      walk(node);
      return hit;
    };

    const bindingNames = (name: ts.BindingName, out: string[]) => {
      if (ts.isIdentifier(name)) out.push(name.text);
      else name.elements.forEach((e) => !ts.isOmittedExpression(e) && bindingNames(e.name, out));
    };

    const tainted = new Set<string>(productionNames);
    let changed = true;
    while (changed) {
      changed = false;
      const mark = (names: string[], source: ts.Node | undefined) => {
        if (!source || !referencesAny(source, tainted)) return;
        for (const n of names) {
          if (!tainted.has(n)) {
            tainted.add(n);
            changed = true;
          }
        }
      };
      const scan = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.initializer) {
          const names: string[] = [];
          bindingNames(node.name, names);
          mark(names, node.initializer);
        } else if (ts.isFunctionDeclaration(node) && node.name && node.body) {
          mark([node.name.text], node.body);
        } else if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left)
        ) {
          mark([node.left.text], node.right);
        } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
          // obj.prop = <production-backed value> taints obj
          let base: ts.Expression = node.left;
          while (ts.isPropertyAccessExpression(base)) base = base.expression;
          if (ts.isIdentifier(base)) mark([base.text], node.right);
        }
        ts.forEachChild(node, scan);
      };
      scan(sf);
    }

    const bodyUsesProduction = (body: ts.Node): boolean => referencesAny(body, tainted);

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node.expression);
        if (name && TEST_CALLEES.has(name) && node.arguments.length >= 2) {
          const fn = node.arguments[node.arguments.length - 1];
          if (ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) {
            if (!bodyUsesProduction(fn.body)) {
              const title = ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : '<dynamic title>';
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
              findings.push({ file, line: line + 1, title });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return findings;
}

function main() {
  const targets = process.argv.slice(2);
  const roots = targets.length > 0 ? targets : ['tests'];
  const allFiles = roots.flatMap((r) => collectTestFiles(r));
  // *.repo.test.ts files assert on repository files (config, ignore rules, docs), not production logic.
  // They are reported separately and are not counted as facade tests.
  const repoFiles = allFiles.filter((f) => f.endsWith('.repo.test.ts'));
  const files = allFiles.filter((f) => !f.endsWith('.repo.test.ts'));
  const findings = findFacadeTests(files);
  for (const f of findings) {
    console.log(`${f.file}:${f.line}  ${f.title}`);
  }
  const perFile = new Map<string, number>();
  findings.forEach((f) => perFile.set(f.file, (perFile.get(f.file) || 0) + 1));
  console.log(`\n${findings.length} facade test(s) in ${perFile.size} file(s) out of ${files.length} scanned.`);
  if (repoFiles.length > 0) {
    console.log(`(${repoFiles.length} repo-file assertion suite(s) not counted: ${repoFiles.join(', ')})`);
  }
  process.exit(findings.length > 0 ? 1 : 0);
}

import { fileURLToPath } from 'url';
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
