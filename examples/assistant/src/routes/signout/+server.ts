import { redirect } from '@sveltejs/kit';
import { getHost } from '$lib/server/app.ts';
import { signOut } from '$lib/server/login.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies }) => {
  await signOut(await getHost(), cookies);
  redirect(303, '/signin');
};
