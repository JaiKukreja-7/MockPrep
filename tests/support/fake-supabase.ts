/**
 * A recording stand-in for the Supabase client's query builder.
 *
 * Every method call on `from(table)` appends to a chain and returns the same
 * builder; awaiting it (or `.maybeSingle()` / `.single()`, which are just
 * more chain entries) resolves through the `resolve` function you pass in,
 * which sees the whole chain and decides what the database would have said.
 * `rpc(name, args)` records the same way under the table `rpc:name`.
 *
 * Nothing about RLS or SQL is simulated — that is what the integration
 * project is for. This exists so the code around the queries (thresholds,
 * mappings, error paths) can be exercised without a network.
 */

export interface RecordedOp {
  table: string;
  chain: Array<[method: string, args: unknown[]]>;
}

export interface Reply {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}

export type Resolver = (op: RecordedOp) => Reply;

export function fakeSupabase(resolve: Resolver) {
  const ops: RecordedOp[] = [];

  const builder = (table: string) => {
    const op: RecordedOp = { table, chain: [] };
    ops.push(op);
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, method: string) {
          if (method === "then") {
            return (onFulfilled: (v: Reply) => unknown, onRejected?: (e: unknown) => unknown) =>
              Promise.resolve()
                .then(() => ({ data: null, error: null, ...resolve(op) }))
                .then(onFulfilled, onRejected);
          }
          return (...args: unknown[]) => {
            op.chain.push([method, args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  };

  const client = {
    from: builder,
    rpc: (name: string, args?: unknown) => {
      const op: RecordedOp = { table: `rpc:${name}`, chain: [["rpc", [args]]] };
      ops.push(op);
      return Promise.resolve({ data: null, error: null, ...resolve(op) });
    },
  };

  return { client, ops };
}

/** The args of the first `method` call in an op's chain, or undefined. */
export function argsOf(op: RecordedOp, method: string): unknown[] | undefined {
  return op.chain.find(([m]) => m === method)?.[1];
}

/** True if the chain contains `method` called with exactly these args. */
export function called(op: RecordedOp, method: string, ...args: unknown[]): boolean {
  return op.chain.some(
    ([m, a]) => m === method && JSON.stringify(a) === JSON.stringify(args),
  );
}

/** True if `method` appears anywhere in the chain, whatever its arguments. */
export function has(op: RecordedOp, method: string): boolean {
  return op.chain.some(([m]) => m === method);
}
