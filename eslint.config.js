import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
    ignores: ['**/dist/**', '**/node_modules/**'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs?.['strict-type-checked']?.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-console': 'error',
      // Untrusted HTML (e.g. update release notes) must be rendered from an
      // allow-listed tree. The Property selectors also catch createElement
      // props and JSX spreads, which a JSXAttribute-only selector misses.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXAttribute[name.name='dangerouslySetInnerHTML'], Property[key.name='dangerouslySetInnerHTML'], Property[key.value='dangerouslySetInnerHTML']",
          message: 'Render untrusted HTML via an allow-listed tree (see ReleaseNotes).',
        },
      ],
    },
  },
  {
    files: ['packages/*/src/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/out/**', '**/*.config.*', '**/__fixtures__/generate.ts'],
  },
];
