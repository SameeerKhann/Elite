// Vercel serverless entry point.
// Vercel auto-detects files in /api as serverless functions and installs
// dependencies from the root package.json. This simply exposes the Express
// app (which lives in ../server/server.js) as the handler; the vercel.json
// rewrite routes every incoming path here.
module.exports = require('../server/server.js');
