import {fileURLToPath} from 'node:url';
export default phase => ({
 distDir:phase==='phase-development-server'?'.next-dev':'.next',
 output:'standalone',
 outputFileTracingRoot:fileURLToPath(new URL('../../',import.meta.url)),
});
