// The few Node.js APIs this plugin uses, declared here so type-checking never depends on
// @types/node being installed. Obsidian's automated review resolves these, but not @types/node.

declare module "child_process" {
  interface ExecFileOptions {
    cwd?: string;
    encoding?: "buffer" | "utf8";
    maxBuffer?: number;
    windowsHide?: boolean;
    env?: Record<string, string | undefined>;
  }
  export function execFile(
    file: string,
    args: string[],
    options: ExecFileOptions,
    callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void,
  ): unknown;
}

declare module "fs" {
  export interface Stats {
    size: number;
    mtimeMs: number;
    atimeMs: number;
  }
  export interface Dirent {
    name: string;
    isFile(): boolean;
    isDirectory(): boolean;
  }
  export const promises: {
    stat(path: string): Promise<Stats>;
    readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
    readFile(path: string): Promise<Buffer>;
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    copyFile(src: string, dst: string): Promise<void>;
    utimes(path: string, atime: number, mtime: number): Promise<void>;
    mkdir(path: string, options: { recursive: true }): Promise<unknown>;
    rm(path: string, options: { recursive?: boolean; force?: boolean }): Promise<void>;
    rmdir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
  };
}

declare module "os" {
  export function homedir(): string;
  export function hostname(): string;
}

declare module "path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export const posix: { extname(path: string): string };
}

declare module "crypto" {
  interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare class Buffer extends Uint8Array {
  static from(data: string): Buffer;
  toString(encoding?: "base64" | "utf8"): string;
  equals(other: Uint8Array): boolean;
}

declare const process: { env: Record<string, string | undefined> };
