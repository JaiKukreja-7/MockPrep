/**
 * Next inlines `process.env.NEXT_PUBLIC_*` by literal text substitution at
 * build time, so these must be written out in full — a dynamic lookup like
 * `process.env[name]` resolves to undefined in the browser bundle.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.local.example to .env.local and fill in ` +
        `your Supabase project's values (Project Settings → API).`,
    );
  }
  return value;
}

export const supabaseUrl = () => required(url, "NEXT_PUBLIC_SUPABASE_URL");
export const supabaseAnonKey = () =>
  required(anonKey, "NEXT_PUBLIC_SUPABASE_ANON_KEY");

/** True when both public Supabase variables are present. */
export const hasSupabaseEnv = () => Boolean(url && anonKey);
