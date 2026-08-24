// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['node_modules/**', '.expo/**', 'coverage/**', 'dist/**'],
  },
  {
    files: ['jest/**/*.js', '__tests__/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { jest: 'readonly', require: 'readonly' },
    },
  },
]);
