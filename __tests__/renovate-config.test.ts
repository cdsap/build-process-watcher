import * as fs from 'fs';
import * as path from 'path';

type PackageRule = {
  description?: string;
  matchManagers?: string[];
  matchUpdateTypes?: string[];
  automerge?: boolean;
  automergeType?: string;
  automergeStrategy?: string;
  matchDatasources?: string[];
  regexManagers?: unknown;
};

type RenovateConfig = {
  $schema?: string;
  extends?: string[];
  enabledManagers?: string[];
  packageRules?: PackageRule[];
  regexManagers?: unknown[];
};

const renovateConfigPath = path.join(__dirname, '../.github/renovate.json');

function loadConfig(): RenovateConfig {
  return JSON.parse(fs.readFileSync(renovateConfigPath, 'utf8')) as RenovateConfig;
}

describe('Renovate config', () => {
  it('exists as valid JSON under .github/', () => {
    expect(fs.existsSync(renovateConfigPath)).toBe(true);
    expect(() => loadConfig()).not.toThrow();
  });

  it('uses config:base with npm and GitHub Actions managers only', () => {
    const config = loadConfig();

    expect(config.$schema).toBe('https://docs.renovatebot.com/renovate-schema.json');
    expect(config.extends).toEqual(['config:base']);
    expect(config.enabledManagers).toEqual(['npm', 'github-actions']);
    expect(config.regexManagers).toBeUndefined();
  });

  it('automerge is limited to patch/minor updates via PR merge-commit', () => {
    const config = loadConfig();
    const rules = config.packageRules ?? [];

    expect(rules.length).toBeGreaterThanOrEqual(2);

    for (const rule of rules) {
      expect(rule.matchDatasources).toBeUndefined();
      expect(rule.regexManagers).toBeUndefined();
      expect(rule.automerge).toBe(true);
      expect(rule.automergeType).toBe('pr');
      expect(rule.automergeStrategy).toBe('merge-commit');
      expect(rule.matchUpdateTypes).toEqual(['patch', 'minor']);
    }

    const managers = rules.flatMap(rule => rule.matchManagers ?? []).sort();
    expect(managers).toEqual(['github-actions', 'npm']);
  });
});
