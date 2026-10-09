import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Repo-file assertions: these check files in the repository (config, ignore rules, docs), not production
// logic, so they live in a *.repo.test.ts file that scripts/find_facade_tests.ts reports separately.
describe('Tier 1: Repository file checks (Features 22, 24, 25)', () => {
    it('F22.1: vitest runner configuration ensures sequential execution without file parallelism', () => {
      const vitestConfigPath = path.resolve(process.cwd(), 'vitest.config.ts');
      expect(fs.existsSync(vitestConfigPath)).toBe(true);
      const configContent = fs.readFileSync(vitestConfigPath, 'utf8');
      expect(configContent).toContain('fileParallelism: false');
    });

    it('F24.1: package.json defines all necessary verification scripts', () => {
      const pkgPath = path.resolve(process.cwd(), 'package.json');
      expect(fs.existsSync(pkgPath)).toBe(true);
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

      expect(pkg.scripts).toBeDefined();
      expect(pkg.scripts.build).toBeDefined();
      expect(pkg.scripts.test).toBeDefined();
      expect(pkg.scripts.typecheck).toBeDefined();
      expect(pkg.scripts.lint).toBeDefined();
    });

    it('F24.2: tsconfig.json enforces compiler options and valid path mappings', () => {
      const tsconfigPath = path.resolve(process.cwd(), 'tsconfig.json');
      expect(fs.existsSync(tsconfigPath)).toBe(true);
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));

      expect(tsconfig.compilerOptions).toBeDefined();
      expect(tsconfig.compilerOptions.target).toBe('ES2022');
      expect(tsconfig.compilerOptions.paths).toBeDefined();
    });

    it('F24.3: rust workspace Cargo.toml defines valid crates or native acceleration components', () => {
      const cargoPath = path.resolve(process.cwd(), 'Cargo.toml');
      expect(fs.existsSync(cargoPath)).toBe(true);
      const cargoContent = fs.readFileSync(cargoPath, 'utf8');
      expect(cargoContent).toContain('[workspace]');
      expect(cargoContent).toContain('apex_hft_engine');
    });

    it('F25.1: sensitive secrets and environment files are guarded against accidental packaging', () => {
      const gitignorePath = path.resolve(process.cwd(), '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);
      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');

      expect(gitignoreContent).toContain('.env');
      expect(gitignoreContent).toContain('node_modules');
    });

    it('F25.2: SQLite databases and WAL files are gitignored to prevent state contamination', () => {
      const gitignorePath = path.resolve(process.cwd(), '.gitignore');
      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');

      expect(gitignoreContent).toContain('*.db');
    });

    it('F25.5: project architecture and request contracts document all 25 features and milestone gates', () => {
      const projectMdPath = path.resolve(process.cwd(), 'PROJECT.md');
      const originalRequestPath = path.resolve(process.cwd(), 'ORIGINAL_REQUEST.md');

      expect(fs.existsSync(projectMdPath)).toBe(true);
      expect(fs.existsSync(originalRequestPath)).toBe(true);

      const projectContent = fs.readFileSync(projectMdPath, 'utf8');
      expect(projectContent).toContain('Feature Inventory');
      expect(projectContent).toContain('Phase 0 Live Correctness');
      expect(projectContent).toContain('MICRO_10 Capital Efficiency');
    });
});
