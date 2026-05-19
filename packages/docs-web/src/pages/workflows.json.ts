import type { APIRoute } from 'astro';
import { marketplaceEntries } from '../data/marketplace';

export const GET: APIRoute = () => {
  return new Response(JSON.stringify(marketplaceEntries), {
    headers: { 'Content-Type': 'application/json' },
  });
};
