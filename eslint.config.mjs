// Flat ESLint config. Enforces no-any / no-suppression and the acyclic package
// dependency boundary from docs/BUILD_PLAN.md. The dash, banned-word, and secret
// checks live in scripts/check-standards.sh (run by `pnpm check:standards`).
import tseslint from 'typescript-eslint';

// core depends on nothing and does no IO. Everything below is forbidden inside it.
const FORBIDDEN_IN_CORE = [
  { group: ['node:*'], message: 'core must stay pure: no Node built-ins or IO.' },
  { group: ['@solana/*', '@coral-xyz/*'], message: 'core must stay pure: no chain client.' },
  {
    group: [
      '@txline-agent/txline',
      '@txline-agent/onchain-client',
      '@txline-agent/agent',
      '@txline-agent/backtest',
      '@txline-agent/api',
      '@txline-agent/dashboard',
    ],
    message: 'core depends on nothing: move IO code up to txline or agent.',
  },
];

// txline may depend on core only.
const FORBIDDEN_IN_TXLINE = [
  {
    group: [
      '@txline-agent/onchain-client',
      '@txline-agent/agent',
      '@txline-agent/backtest',
      '@txline-agent/api',
      '@txline-agent/dashboard',
    ],
    message: 'txline may depend on core only.',
  },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.turbo/**', '**/coverage/**', '**/*.config.*', '**/*.cjs'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'id-length': ['error', { min: 2, exceptions: ['_'], properties: 'never' }],
    },
  },
  {
    files: ['packages/core/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: FORBIDDEN_IN_CORE }] },
  },
  {
    files: ['packages/txline/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: FORBIDDEN_IN_TXLINE }] },
  },
  {
    files: ['**/*.test.ts'],
    rules: { 'id-length': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
