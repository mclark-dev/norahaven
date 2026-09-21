// Minimal ambient declarations so the project typechecks with zero npm dependencies.
// At runtime these are provided by Node 22 on Vercel.

declare const process: {
  env: Record<string, string | undefined>;
};

declare const Buffer: {
  from(input: any, encoding?: string): any;
};

// WebCrypto (global in Node 18+) — used for Google service-account JWT signing.
declare const crypto: any;

declare module "node:zlib" {
  export function inflateRawSync(buf: any): any;
}

declare module "node:crypto" {
  export function createHash(algo: string): any;
  export function randomBytes(n: number): any;
  export function scryptSync(password: any, salt: any, keylen: number): any;
}

declare function setTimeout(cb: (...args: any[]) => void, ms: number): any;

// Vercel Node function signatures (minimal — avoids the @vercel/node package)
interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  body: any;
}

interface VercelResponse {
  status(code: number): VercelResponse;
  json(body: unknown): void;
  send(body: string): void;
  setHeader(name: string, value: string): void;
}
