'use strict';
import { test } from 'node:test';
import assert from 'node:assert';
import { isOpenable } from '../src/platform/open-file.ts';

test('only viewer formats are openable; anything that runs is not', () => {
  for (const name of ['a.csv', 'B.XLSX', '旧表.xls', 'x.pdf', 'p.PNG', 'n.txt', 'list.m3u8']) {
    assert.strictEqual(isOpenable(name), true, name);
  }
  for (const name of ['a.exe', 'a.bat', 'a.cmd', 'a.ps1', 'a.js', 'a.vbs', 'a.lnk', 'a.hta',
    'a.html', 'a.xlsm', 'a.docm', 'a.csv.exe', 'noext', '', '.csv/evil']) {
    assert.strictEqual(isOpenable(name), false, name);
  }
});
