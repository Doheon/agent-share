// Ambient module declarations for untyped npm packages we depend on.
// Kept in a separate .d.ts so TypeScript picks them up as declarations
// rather than trying to augment the JS modules.

declare module "hyperswarm" {
  interface HyperswarmOptions {
    seed?: Buffer;
    maxPeers?: number;
  }
  interface HyperswarmInstance {
    join(topic: Buffer, options?: { server?: boolean; client?: boolean }): void;
    leave(topic: Buffer): void;
    flush(): Promise<void>;
    destroy(): Promise<void>;
    on(event: "connection", listener: (conn: NodeJS.ReadWriteStream, info: unknown) => void): this;
    peers: Map<string, unknown>;
  }
  function Hyperswarm(options?: HyperswarmOptions): HyperswarmInstance;
  export = Hyperswarm;
}

