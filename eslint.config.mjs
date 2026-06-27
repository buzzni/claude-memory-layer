import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'dist/**',
      '.claude-plugin/**',
      'node_modules/**',
      'coverage/**',
      'memory/**'
    ]
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
      }
    },
    rules: {
      // High-value correctness rules kept as errors.
      'no-constant-condition': ['error', { checkLoops: false }],
      // Existing debt is large; surface these as warnings so they are visible
      // in CI output without blocking, and can be burned down incrementally.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ]
    }
  }
];
