// `server-only` throws when imported outside a React Server Component
// environment. Under Vitest there is no such environment, and the modules
// that import it are exactly the ones worth testing, so it resolves to this.
export {};
