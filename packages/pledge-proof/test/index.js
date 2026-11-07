// Entry point for `node --test packages/pledge-proof/test/`. Node 22 and later read a directory argument as a file,
// so the directory resolves to this file, which loads every test file in the folder.
import './verify.test.js';
import './paypal.test.js';
