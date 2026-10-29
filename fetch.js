// generowanie package-lock.json dla automatu
require('child_process').execSync('npm install --package-lock-only --no-audit --no-fund', {stdio: 'inherit'});
