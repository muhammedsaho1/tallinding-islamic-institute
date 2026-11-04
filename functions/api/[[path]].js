// Cloudflare Pages: serves /api/* using the same code Netlify runs.
import handler from '../../netlify/functions/api.js';

export const onRequest = (context) => {
  // Make the Cloudflare secret available to api.js
  globalThis.__DATABASE_URL = context.env && context.env.DATABASE_URL;
  return handler(context.request);
};
