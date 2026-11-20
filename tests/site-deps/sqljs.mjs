// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT

// sql.js: the build the site ships loads its WASM, runs SQL, and opens a
// database from its bytes, which is how the site reads the database it fetches.

import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fail, ok, shipped } from './lib.mjs'

const script = shipped('sql.js', 'dist/sql-wasm.js')
const wasm = shipped('sql.js', 'dist/sql-wasm.wasm')
const initSqlJs = createRequire(import.meta.url)(script)
const SQL = await initSqlJs({ locateFile: (file) => `${dirname(wasm)}/${file}` })
ok('sql-wasm.js loads its WASM')

const db = new SQL.Database()
db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, n INTEGER)')
const insert = db.prepare('INSERT INTO t (name, n) VALUES (?, ?)')
for (const [name, n] of [['a', 1], ['b', 2], ['c', 3]]) {
	insert.run([name, n])
}
insert.free()
const sum = db.exec("SELECT count(*), sum(n), group_concat(name, '') FROM t")[0]?.values[0]
if (JSON.stringify(sum) !== JSON.stringify([3, 6, 'abc'])) {
	fail(`unexpected result of the select: ${JSON.stringify(sum)}`)
}
ok('a table takes rows and gives them back')

const bytes = db.export()
db.close()
const copy = new SQL.Database(bytes)
const rows = copy.exec('SELECT name FROM t WHERE n > 1 ORDER BY n')[0]?.values.flat()
copy.close()
if (JSON.stringify(rows) !== JSON.stringify(['b', 'c'])) {
	fail(`a database opened from its bytes gives ${JSON.stringify(rows)}`)
}
ok('a database opens from its bytes')
