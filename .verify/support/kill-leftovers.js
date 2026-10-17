'use strict';
/** Kill leftover TabAgent.exe processes and report what was found. */
const { execFileSync } = require('node:child_process');

function list(name) {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
    return out.split(/\r?\n/)
      .filter((l) => l.toUpperCase().includes(name.toUpperCase()))
      .map((l) => l.split('","')[1])
      .filter(Boolean);
  } catch { return []; }
}

function kill(name) {
  const pids = list(name);
  if (!pids.length) { console.log(name + ': none running'); return 0; }
  console.log(name + ': killing ' + pids.join(', '));
  for (const pid of pids) {
    try { execFileSync('taskkill', ['/PID', pid, '/F', '/T'], { stdio: 'ignore' }); } catch {}
  }
  return pids.length;
}

const n = kill('TabAgent.exe');
console.log('killed ' + n + ' process(es)');
