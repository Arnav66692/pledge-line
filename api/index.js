// The one Vercel function. vercel.json routes every path here, and src/vercel.js answers with the local server's
// own handler, in mock mode only. See DEPLOY-VERCEL.md.
import { createVercelHandler } from '../src/vercel.js';

export default { fetch: createVercelHandler() };
