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
  // api/index.js is the generated Vercel function bundle (npm run build:api), not source.
  { ignores: ['**/dist/**', '**/coverage/**', 'docs/**', 'api/index.js'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root config files belong to no workspace tsconfig.
          allowDefaultProject: ['*.js', '*.ts', 'apps/web/public/*.js'],
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
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              ...appPattern('api'),
              // apps/web/src/api/ is the web app's own network code (one module per resource),
              // imported as ./api/x.ts or ../api/x.ts (x.tsx for ApiContext.tsx and the test helper
              // renderWithApi.tsx): not apps/api, which `**/../api/**` would otherwise take it for.
              // Only its files, no deeper path, so `../../api/src/…` and `../api/src/…` still fail.
              group: [
                ...appPattern('api').group,
                '!./api/*.ts',
                '!../api/*.ts',
                '!./api/*.tsx',
                '!../api/*.tsx',
              ],
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/public/sw.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: globals.serviceworker },
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
