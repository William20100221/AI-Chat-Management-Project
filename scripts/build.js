// Builds the installers people download:
//   Windows  dist/AI-Chat-Manager-Setup-<version>.exe
//            one click: installs for you (no admin), adds Start menu and desktop shortcuts, starts the app
//   Mac      dist/AI-Chat-Manager-<version>-mac-<arm64|x64>.dmg and .zip (Apple Silicon and Intel)
//
//   node scripts/build.js win | mac | all        (npm run dist:win, dist:mac, dist)
//
// Best built on the system it's for (GitHub Actions does both: .github/workflows/installers.yml).
// It also works from Linux:
//   - Windows: electron-builder normally runs part of the installer under Wine to take out its
//     uninstaller; on a Mac it reads it straight out of the file instead. We do that here too.
//   - Mac: Apple's tools aren't there, so the app is built as a folder, signed "ad hoc" with
//     rcodesign (https://github.com/indygreg/apple-platform-rs; set RCODESIGN to its path) because
//     Apple Silicon Macs won't open an app without a signature, then zipped keeping its links.
//     A .dmg needs a Mac.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const which = process.argv[2] || 'all';
const onMac = process.platform === 'darwin';
const onLinux = process.platform === 'linux';

async function buildWindows(builder) {
  if (onLinux) {
    // The same pure-JavaScript route electron-builder takes on macOS: no Wine needed.
    require('app-builder-lib/out/util/macosVersion').isMacOsCatalina = () => true;
  }
  await builder.build({ targets: builder.Platform.WINDOWS.createTarget(), publish: 'never' });
}

async function buildMac(builder) {
  if (onMac) {
    await builder.build({ targets: builder.Platform.MAC.createTarget(), publish: 'never' });
    return;
  }
  if (process.platform === 'win32') {
    console.log('The Mac app can’t be built on Windows (it needs links Windows can’t make). Use a Mac or GitHub Actions.');
    return;
  }
  const rcodesign = process.env.RCODESIGN || findOnPath('rcodesign');
  for (const arch of ['arm64', 'x64']) {
    await builder.build({
      targets: builder.Platform.MAC.createTarget(['dir'], builder.Arch[arch]),
      publish: 'never',
    });
    const folder = path.join(root, 'dist', arch === 'x64' ? 'mac' : `mac-${arch}`);
    const appName = `${pkg.build.productName}.app`;
    if (rcodesign) {
      execFileSync(rcodesign, ['sign', path.join(folder, appName)], { stdio: 'inherit' });
    } else {
      console.warn(`No rcodesign found: the ${arch} app is unsigned${arch === 'arm64' ? ' and Apple Silicon Macs will refuse to open it' : ''}.`);
    }
    const zipFile = path.join(root, 'dist', `AI-Chat-Manager-${pkg.version}-mac-${arch}.zip`);
    fs.rmSync(zipFile, { force: true });
    // -y keeps the frameworks' links as links (following them would triple the size and break the app)
    execFileSync('zip', ['-qry9', zipFile, appName], { cwd: folder, stdio: 'inherit' });
    console.log(`Built ${path.relative(root, zipFile)}`);
  }
}

function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

(async () => {
  const builder = require('electron-builder');
  if (which === 'win' || which === 'all') await buildWindows(builder);
  if (which === 'mac' || which === 'all') await buildMac(builder);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
