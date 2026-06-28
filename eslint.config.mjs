// @ts-check
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  // Global ignores — dist, generated, and experimental POC code
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/target/**', 'pocs/**', 'scripts/**', '**/*.d.ts'],
  },

  // TypeScript-ESLint recommended rules for all .ts / .tsx files
  ...tseslint.configs.recommended,

  // React hooks rules — naming conventions are identical for Preact hooks
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Disable all ESLint formatting rules — Prettier owns formatting
  prettierConfig,

  // Project-wide rule overrides
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
