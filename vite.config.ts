import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  // Also expose the NEXT_PUBLIC_* variables that Vercel's Supabase integration creates (public by design).
  envPrefix: ['VITE_', 'NEXT_PUBLIC_SUPABASE_'],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
