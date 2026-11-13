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
      'no-restricted-imports': ['error', { patterns: [appPattern('api')] }],
    },
  },
  {
    // apps/web/src/api/ is the web app's own network code (one module per resource), imported from
    // apps/web/src as ./api/x.ts or ../api/x.ts (x.tsx for ApiContext.tsx and the test helper
    // renderWithApi.tsx): not apps/api, which `**/../api/**` would otherwise take it for. The
    // exemption covers only files directly in a sibling or child `api/` folder, and only for files
    // under apps/web/src: `../../api/src/…` and `../api/src/…` still fail, and so does any
    // `../api/…` from apps/web itself (vite.config.ts), where it would mean apps/api.
    // This replaces the block above's options for these files (flat config does not merge them),
    // so it repeats the same boundary plus the exemption.
    files: ['apps/web/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              ...appPattern('api'),
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

  // --- Test helpers ---------------------------------------------------------
  // Test-only modules, so production code (and the web bundle) never depends on them:
  // packages/shared/src/testing (`@bottlerun/shared/testing`: deferred, firstRealStreet, the
  // makeOrder fixtures), and the helpers that live next to the code they serve (listed by file
  // name below). This uses the typescript-eslint copy of no-restricted-imports, a separate rule from the core one above:
  // flat config replaces a rule's options instead of merging them, so sharing the core rule would
  // make the test-file exception below also drop the workspace boundaries for test files.
  {
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@bottlerun/shared/testing',
                '@bottlerun/shared/testing/*',
                // Relative forms: from inside packages/shared/src, and from anywhere by path.
                './testing',
                './testing/*',
                '../testing',
                '../testing/*',
                '**/shared/src/testing',
                '**/shared/src/testing/**',
              ],
              message:
                'shared/testing is for tests only: import it from *.test.ts(x) or *.contract.ts.',
            },
            {
              // A file name without a slash matches it in any folder, by any relative path.
              group: [
                // apps/web/src/api: the fake fetch, the shared expected order, the render helper.
                'fakeFetch.ts',
                'testFixtures.ts',
                'renderWithApi.tsx',
                // apps/api/src: supertest headers, session cookies, the opt-in real MongoDB,
                // VAPID keys. (fakeDeps.ts and the fakes it builds on are not here: the local demo
                // server, demoServer.ts, runs on them.)
                'testRequest.ts',
                'testSession.ts',
                'testMongo.ts',
                'testVapidKeys.ts',
                // The shared suites every implementation's tests run (they import vitest).
                '*.contract.ts',
              ],
              message: 'Test helper: import it only from *.test.ts(x) or *.contract.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    // Tests, and the repo contracts (*.contract.ts) that tests run against each implementation.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.contract.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': 'off' },
  },
);
