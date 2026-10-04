#!/usr/bin/env node
/**
 * npm `bin` entry for `etab`.
 *
 * The shebang lives here and not in desktop.ts because desktop.js is also the
 * entry the SEA bundler wraps in a function body (tools/bundle.js), and a
 * shebang anywhere but the first bytes of a file is a syntax error. With it in
 * desktop.ts the packaged exe died on launch. npm needs the shebang, though:
 * without one its Windows shim runs the .js file directly and the user gets an
 * "Open with" dialog instead of node.
 *
 * desktop.ts starts itself on load, so importing it is the whole program.
 */
import './desktop.ts';
