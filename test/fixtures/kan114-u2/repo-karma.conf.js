// Synthetic fixture (not repository code): a repo karma config shaped like the pattern-B tasks' own config, whose
// local launcher disables the Chromium sandbox and which adds coverage/sauce reporters from the environment.
module.exports = function (config) {
  const sauce = String(process.env.RUN_SAUCE_LABS) === 'true';
  config.set({
    browsers: sauce ? ['sl_chrome'] : ['ChromeNoSandboxHeadless'],
    frameworks: ['mocha', 'chai-sinon'],
    reporters: ['mocha'].concat(String(process.env.COVERAGE) === 'true' ? 'coverage' : []),
    customLaunchers: {
      ChromeNoSandboxHeadless: { base: 'Chrome', flags: ['--no-sandbox', '--disable-setuid-sandbox', '--headless', '--remote-debugging-port=9333'] },
    },
    sauceLabs: { startConnect: sauce },
    files: [{ pattern: config.grep || 'test/**/*.test.js', watched: false }],
    browserNoActivityTimeout: 300000,
  });
};
