// ESLint flat config. Besides code style, this file is the architecture check:
// the import boundaries between workspaces are enforced here (no-restricted-imports),
// which is why `checks.sh arch` SKIPs instead of running a separate tool.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const appPattern = (app) => ({
  group: [`@bottlerun/${app}`, `@bottlerun/${app}/*`, `**/apps/${app}/**`, `**/../${app}/**`],
  message: `apps must not import from apps/${app}. Move shared code to packages/shared.`,
});

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', 'docs/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root config files belong to no workspace tsconfig.
          allowDefaultProject: ['*.js', '*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: globals.node },
  },

  // --- Boundaries -----------------------------------------------------------
  {
    files: ['apps/web/**'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': ['error', { patterns: [appPattern('api')] }],
    },
  },
  {
    files: ['apps/api/**'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-imports': ['error', { patterns: [appPattern('web')] }],
    },
  },
  {
    // shared runs in the browser and in Node: no framework, no app code.
    files: ['packages/shared/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'express', message: 'packages/shared must stay isomorphic.' },
            { name: 'react', message: 'packages/shared must stay isomorphic.' },
          ],
          patterns: [appPattern('api'), appPattern('web')],
        },
      ],
    },
  },
  {
    // One-off Node scripts (scripts/geocode-streets.ts) maintain shared data: they may use
    // @bottlerun/shared, never app code.
    files: ['scripts/**'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-imports': ['error', { patterns: [appPattern('api'), appPattern('web')] }],
    },
  },
);
