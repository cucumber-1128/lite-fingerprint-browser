'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function reattachBrowserVersionFromChild(profileId) {
  const launchPath = path.resolve(__dirname, '../src/launch.js');
  const script = `
const launcher = require(${JSON.stringify(launchPath)});
launcher.reattach().then((profiles) => {
  const profile = profiles.find((item) => item.profileId === ${JSON.stringify(profileId)});
  if (!profile) throw new Error('Profile was not reattached');
  process.stdout.write(JSON.stringify({ browserVersion: profile.browserVersion }), () => process.exit(0));
}).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: process.env,
    encoding: 'utf8',
    timeout: 20000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error('Reattachment child failed: ' + (result.stderr || result.stdout || result.status));
  }
  return JSON.parse(result.stdout || '{}').browserVersion;
}

async function runStandalone() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-reattach-version-'));
  process.env.FB_DATA = dataDir;
  const store = require('../src/store');
  const launcher = require('../src/launch');
  let profileId = null;
  try {
    const profile = store.create({ name: 'reattach-browser-version' });
    profileId = profile.id;
    const launched = await launcher.launch(profileId);
    const version = reattachBrowserVersionFromChild(profileId);
    if (version !== launched.browserVersion) {
      throw new Error('Expected ' + launched.browserVersion + ', received ' + version);
    }
    console.log('reattach preserved browserVersion ' + version);
  } finally {
    if (profileId) {
      await launcher.stop(profileId);
      store.remove(profileId);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

module.exports = { reattachBrowserVersionFromChild };

if (require.main === module) {
  runStandalone().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
