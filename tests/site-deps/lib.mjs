// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT

// What the tests of the site libraries share. Each library is taken from
// site/node_modules, where npm ci put the version site/package-lock.json names,
// and from the very file the site workflow ships.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const site = fileURLToPath(new URL('../../site/', import.meta.url))
// jsdom is a devDependency of the site, so it resolves from there and not from
// this directory.
const { JSDOM } = createRequire(`${site}package.json`)('jsdom')

export function fail(message) {
	console.error(`FAIL: ${message}`)
	process.exit(1)
}

export function ok(message) {
	console.log(`ok: ${message}`)
}

// The path of a file of a package, which must exist: the site workflow copies
// it from there and fails when it is gone.
export function shipped(pkg, file) {
	const path = `${site}node_modules/${pkg}/${file}`
	if (!existsSync(path)) {
		fail(`${pkg} has no ${file}, which the site ships`)
	}
	return path
}

export function siteFile(file) {
	return readFileSync(`${site}${file}`, 'utf8')
}

// A window with the script evaluated in it as a classic script, the way
// index.html loads the libraries.
export function windowWith(path, prepare = () => {}) {
	const { window } = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' })
	prepare(window)
	window.eval(readFileSync(path, 'utf8'))
	return window
}
