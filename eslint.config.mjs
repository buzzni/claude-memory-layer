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
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
      }
    },
    rules: {}
  }
];
