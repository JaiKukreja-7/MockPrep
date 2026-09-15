"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseOutage, OUTAGE_MESSAGE } from "@/lib/supabase/outage";

function safeNext(next: FormDataEntryValue | null): string {
  const value = typeof next === "string" ? next : "";
  // Only same-origin paths. "//evil.com" is a protocol-relative URL, so the
  // second character has to be checked too.
  return value.startsWith("/") && !value.startsWith("//") ? value : "/dashboard";
}

async function origin() {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const protocol = headerList.get("x-forwarded-proto") ?? "http";
  return `${protocol}://${host}`;
}

/**
 * Passwordless email sign-in. Supabase mails a one-time link; the user lands
 * on /auth/callback, which completes the exchange.
 */
export async function signInWithEmail(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const next = safeNext(formData.get("next"));

  if (!email) {
    redirect(`/sign-in?error=${encodeURIComponent("Enter your email address.")}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${await origin()}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });

  if (error) {
    redirect(`/sign-in?error=${encodeURIComponent(isSupabaseOutage(error) ? OUTAGE_MESSAGE : error.message)}`);
  }

  redirect(`/sign-in?sent=${encodeURIComponent(email)}`);
}

/**
 * Password sign-in, alongside the magic link.
 *
 * The link is still the front door — this exists because Supabase's default
 * SMTP is rate-limited hard enough to make link delivery unreliable.
 */
export async function signInWithPassword(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNext(formData.get("next"));

  if (!email || !password) {
    redirect(
      `/sign-in?error=${encodeURIComponent("Enter your email and password.")}`,
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    redirect(`/sign-in?error=${encodeURIComponent(isSupabaseOutage(error) ? OUTAGE_MESSAGE : error.message)}`);
  }

  redirect(next);
}

/** Guest sign-in. Creates a real auth user with is_anonymous set. */
export async function signInAsGuest(formData: FormData) {
  const next = safeNext(formData.get("next"));

  const supabase = await createClient();
  const { error } = await supabase.auth.signInAnonymously();

  if (error) {
    redirect(`/sign-in?error=${encodeURIComponent(isSupabaseOutage(error) ? OUTAGE_MESSAGE : error.message)}`);
  }

  redirect(next);
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/sign-in");
}
