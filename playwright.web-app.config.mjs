import base from './playwright.config.mjs';
export default {
  ...base, globalSetup: undefined, testMatch: ['**/web-app.spec.mjs'],
  outputDir: 'test-results/pwa-artifacts',
  reporter: [['list'], ['html', { outputFolder: 'test-results/pwa-report', open: 'never' }], ['json', { outputFile: 'test-results/pwa-report/results.json' }]],
};
