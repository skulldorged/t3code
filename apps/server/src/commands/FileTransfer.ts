// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off globalDateInEffect:off -- copies need lstat, modes, renames and tar, and stream bodies larger than memory.
// Fork: `t3_copy`, files and folders between this machine and linked ones.
// A linked machine serves its side at FILES_ROUTE, behind the same bearer
// credential as its /mcp: a file goes as it is, a folder as a tar.gz. Uploads
// go in chunks under Cloudflare's 100 MB request limit and are installed
// next to their target, then renamed into place, so a failed copy leaves
// nothing half-written there.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { resolveUserPath } from "./CommandJobs.ts";

export const FILES_ROUTE = "/mcp/files";
/** Under Cloudflare's 100 MB request body limit, with room for a slow link. */
const CHUNK_BYTES = 32 * 1024 * 1024;
const KIND_HEADER = "x-t3-copy-kind";
const MODE_HEADER = "x-t3-copy-mode";
/** Uploads left unfinished this long are removed. */
const STALE_UPLOAD = Duration.days(1);
const TRANSFER_ID = /^[a-z0-9]{16,40}$/;

export type CopyKind = "file" | "directory";

export interface CopyEnd {
  readonly environmentId?: EnvironmentId | undefined;
  readonly path: string;
}

interface Limits {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** A failure the HTTP side answers with its status, and the tool side as a tool failure. */
export class TransferError extends Schema.TaggedError<TransferError>()("TransferError", {
  status: Schema.Number,
  message: Schema.String,
}) {}

const isTransferError = Schema.is(TransferError);

const fail = (status: number, message: string): never => {
  throw new TransferError({ status, message });
};

const asTransferError = (cause: unknown) =>
  isTransferError(cause) ? cause : new TransferError({ status: 500, message: messageOf(cause) });

const isCode = (cause: unknown, code: string) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const toFailure = (cause: unknown) =>
  new OrchestratorMcpFailure({
    code: isTransferError(cause) && cause.status < 500 ? "invalid_request" : "orchestration_error",
    message: messageOf(cause),
  });

const newId = () => NodeCrypto.randomBytes(12).toString("hex");

/** Runs tar, failing with what it printed. */
const tar = (args: ReadonlyArray<string>, options: { readonly stdout?: number | "ignore" } = {}) =>
  new Promise<void>((done, failed) => {
    const child = NodeChildProcess.spawn("tar", args, {
      // macOS tar would otherwise add AppleDouble `._` files for extended attributes.
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdio: ["ignore", options.stdout ?? "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8").on("data", (text: string) => {
      if (stderr.length < 4000) stderr += text;
    });
    child.once("error", failed);
    child.once("exit", (code) =>
      code === 0
        ? done()
        : failed(
            new TransferError({
              status: 500,
              message: `tar failed (${code}): ${stderr.trim() || "no output"}`,
            }),
          ),
    );
  });

export class FileTransfer extends Context.Service<
  FileTransfer,
  {
    /** `t3_copy` for a caller here, with the caller's limits for the links it uses. */
    readonly copy: (input: {
      readonly from: CopyEnd;
      readonly to: CopyEnd;
      readonly overwrite: boolean;
      readonly hereId: EnvironmentId;
      readonly limits: Limits;
    }) => Effect.Effect<
      {
        readonly kind: CopyKind;
        readonly bytes: number;
        readonly from: string;
        readonly to: string;
      },
      OrchestratorMcpFailure
    >;
    /** What FILES_ROUTE's GET answers: the file, or the folder packed. */
    readonly serve: (path: string) => Effect.Effect<
      {
        readonly kind: CopyKind;
        readonly mode: number;
        readonly file: string;
        readonly size: number;
        readonly cleanup: Effect.Effect<void>;
      },
      TransferError
    >;
    /** One chunk of FILES_ROUTE's POST; the last one installs what came. */
    readonly receive: (input: {
      readonly path: string;
      readonly kind: CopyKind;
      readonly mode: number;
      readonly transfer: string;
      readonly offset: number;
      readonly final: boolean;
      readonly overwrite: boolean;
      readonly body: AsyncIterable<Uint8Array>;
    }) => Effect.Effect<{ readonly received: number; readonly path: string }, TransferError>;
  }
>()("t3/commands/FileTransfer") {}

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const home = yield* HostProcess.HomeDirectory;
  const links = yield* PeerLinks.PeerLinks;
  const transfersDir = NodePath.join(stateDir, "commands", "transfers");

  const prepareDir = () => NodeFSP.mkdir(transfersDir, { recursive: true, mode: 0o700 });

  /** The source as one file here: the file itself, or the folder packed into a tar.gz. */
  const pack = async (path: string) => {
    const stat = await NodeFSP.stat(path).catch((cause: unknown) =>
      fail(isCode(cause, "ENOENT") ? 404 : 500, `${path}: ${messageOf(cause)}`),
    );
    const mode = stat.mode & 0o7777;
    if (stat.isFile()) {
      return { kind: "file" as const, mode, file: path, size: stat.size, temporary: false };
    }
    if (!stat.isDirectory()) return fail(400, `${path} is neither a file nor a folder.`);
    await prepareDir();
    const file = NodePath.join(transfersDir, `${newId()}.tar.gz`);
    try {
      await tar(["-czf", file, "-C", path, "."]);
    } catch (cause) {
      await NodeFSP.rm(file, { force: true });
      throw cause;
    }
    return {
      kind: "directory" as const,
      mode,
      file,
      size: (await NodeFSP.stat(file)).size,
      temporary: true,
    };
  };

  /**
   * Puts `source` at `target`: written next to it under a temporary name,
   * then renamed into place, replacing what was there only with `overwrite`.
   */
  const install = async (input: {
    readonly source: string;
    readonly kind: CopyKind;
    readonly mode: number;
    readonly target: string;
    readonly overwrite: boolean;
  }) => {
    const existing = await NodeFSP.lstat(input.target).catch(() => undefined);
    if (existing !== undefined && !input.overwrite) {
      fail(409, `${input.target} already exists; pass overwrite to replace it.`);
    }
    await NodeFSP.mkdir(NodePath.dirname(input.target), { recursive: true });
    const partial = `${input.target}.t3-copy-${newId()}`;
    try {
      if (input.kind === "file") {
        await NodeFSP.copyFile(input.source, partial);
        await NodeFSP.chmod(partial, input.mode);
      } else {
        await NodeFSP.mkdir(partial, { mode: 0o700 });
        await tar(["-xzf", input.source, "-C", partial]);
        await NodeFSP.chmod(partial, input.mode);
      }
      if (existing !== undefined) await NodeFSP.rm(input.target, { recursive: true, force: true });
      await NodeFSP.rename(partial, input.target);
    } catch (cause) {
      await NodeFSP.rm(partial, { recursive: true, force: true });
      throw cause;
    }
  };

  const serve: FileTransfer["Service"]["serve"] = (path) =>
    Effect.tryPromise({
      try: async () => {
        const packed = await pack(resolveUserPath(path, home));
        return {
          kind: packed.kind,
          mode: packed.mode,
          file: packed.file,
          size: packed.size,
          cleanup: packed.temporary
            ? Effect.promise(() => NodeFSP.rm(packed.file, { force: true }))
            : Effect.void,
        };
      },
      catch: asTransferError,
    });

  const receive: FileTransfer["Service"]["receive"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        if (!TRANSFER_ID.test(input.transfer)) fail(400, "Bad transfer id.");
        const target = resolveUserPath(input.path, home);
        await prepareDir();
        const staging = NodePath.join(transfersDir, `${input.transfer}.up`);
        const size = await NodeFSP.stat(staging).then(
          (stat) => stat.size,
          () => 0,
        );
        if (input.offset !== size && input.offset !== 0) {
          fail(409, `This upload has ${size} bytes, not ${input.offset}.`);
        }
        if (input.offset === 0) {
          // A target that exists fails now, not after the whole upload.
          if (
            !input.overwrite &&
            (await NodeFSP.lstat(target).catch(() => undefined)) !== undefined
          ) {
            fail(409, `${target} already exists; pass overwrite to replace it.`);
          }
        }
        const out = NodeFS.createWriteStream(staging, {
          flags: input.offset === 0 ? "w" : "a",
          mode: 0o600,
        });
        await NodeStreamPromises.pipeline(input.body, out);
        const received = (await NodeFSP.stat(staging)).size;
        if (input.final) {
          try {
            await install({
              source: staging,
              kind: input.kind,
              mode: input.mode,
              target,
              overwrite: input.overwrite,
            });
          } finally {
            await NodeFSP.rm(staging, { force: true });
          }
        }
        return { received, path: target };
      },
      catch: asTransferError,
    });

  const peerRequest = async (
    resolved: PeerLinks.ResolvedPeerLink,
    limits: Limits,
    query: Record<string, string>,
    init: { readonly method: "GET" | "POST"; readonly body?: Uint8Array },
  ) => {
    const url = new URL(`${resolved.url}${FILES_ROUTE}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${resolved.token}`,
        "t3-mode-limit": `${limits.runtimeMode}/${limits.interactionMode}`,
        ...(init.body === undefined ? {} : { "content-type": "application/octet-stream" }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    if (response.status === 404 && init.method === "POST") {
      fail(502, `${resolved.link.label} does not take copies yet: update T3 Code there.`);
    }
    if (!response.ok) {
      const text = (await response.text().catch(() => "")).trim().slice(0, 2000);
      fail(response.status, `${resolved.link.label}: ${text || `HTTP ${response.status}`}`);
    }
    return { response, label: resolved.link.label };
  };

  /** The source as a file here, fetched from a linked machine when it is there. */
  const fetchSource = async (
    from: CopyEnd,
    peer: PeerLinks.ResolvedPeerLink | undefined,
    limits: Limits,
  ) => {
    if (peer === undefined) {
      const path = resolveUserPath(from.path, home);
      return { ...(await pack(path)), shown: path };
    }
    const { response, label } = await peerRequest(
      peer,
      limits,
      { path: from.path },
      {
        method: "GET",
      },
    );
    const kind = response.headers.get(KIND_HEADER);
    if (kind !== "file" && kind !== "directory") {
      return fail(502, `${label} answered a copy without saying what it is: update T3 Code there.`);
    }
    const mode = Number.parseInt(response.headers.get(MODE_HEADER) ?? "", 8);
    await prepareDir();
    const file = NodePath.join(transfersDir, `${newId()}.down`);
    try {
      if (response.body === null) fail(502, `${label} sent nothing.`);
      await NodeStreamPromises.pipeline(
        response.body as unknown as AsyncIterable<Uint8Array>,
        NodeFS.createWriteStream(file, { mode: 0o600 }),
      );
    } catch (cause) {
      await NodeFSP.rm(file, { force: true });
      throw cause;
    }
    return {
      kind: kind as CopyKind,
      mode: Number.isNaN(mode) ? (kind === "file" ? 0o644 : 0o755) : mode,
      file,
      size: (await NodeFSP.stat(file)).size,
      temporary: true,
      shown: `${label}:${from.path}`,
    };
  };

  /** The link to an end on another machine; undefined for one here. */
  const peerOf = (end: CopyEnd, hereId: EnvironmentId) =>
    end.environmentId === undefined || end.environmentId === hereId
      ? Effect.undefined
      : links.resolve(end.environmentId).pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: error.reason === "unknown_link" ? "invalid_request" : "orchestration_error",
                message: error.message,
              }),
          ),
        );

  const copy: FileTransfer["Service"]["copy"] = Effect.fn("FileTransfer.copy")(function* (input) {
    const fromPeer = yield* peerOf(input.from, input.hereId);
    const toPeer = yield* peerOf(input.to, input.hereId);
    return yield* Effect.tryPromise({
      try: async () => {
        const source = await fetchSource(input.from, fromPeer, input.limits);
        try {
          const to = input.to;
          if (toPeer === undefined) {
            const target = resolveUserPath(to.path, home);
            await install({
              source: source.file,
              kind: source.kind,
              mode: source.mode,
              target,
              overwrite: input.overwrite,
            });
            return { kind: source.kind, bytes: source.size, from: source.shown, to: target };
          }
          const transfer = newId();
          const handle = await NodeFSP.open(source.file, "r");
          let shownTarget = to.path;
          let label = "";
          try {
            let offset = 0;
            const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(source.size, 1)));
            let final = false;
            while (!final) {
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
              final = offset + bytesRead >= source.size;
              const sent = await peerRequest(
                toPeer,
                input.limits,
                {
                  path: to.path,
                  kind: source.kind,
                  mode: source.mode.toString(8),
                  transfer,
                  offset: String(offset),
                  final: final ? "1" : "0",
                  overwrite: input.overwrite ? "1" : "0",
                },
                { method: "POST", body: buffer.subarray(0, bytesRead) },
              );
              label = sent.label;
              const answer = (await sent.response.json().catch(() => ({}))) as { path?: unknown };
              if (typeof answer.path === "string") shownTarget = answer.path;
              offset += bytesRead;
            }
          } finally {
            await handle.close();
          }
          return {
            kind: source.kind,
            bytes: source.size,
            from: source.shown,
            to: `${label}:${shownTarget}`,
          };
        } finally {
          if (source.temporary) await NodeFSP.rm(source.file, { force: true });
        }
      },
      catch: toFailure,
    });
  });

  // Pieces of copies that never finished, such as a server stopped mid-upload.
  yield* Effect.promise(async () => {
    const cutoff = Date.now() - Duration.toMillis(STALE_UPLOAD);
    const names = await NodeFSP.readdir(transfersDir).catch(() => [] as Array<string>);
    for (const name of names) {
      const file = NodePath.join(transfersDir, name);
      const stat = await NodeFSP.stat(file).catch(() => undefined);
      if (stat !== undefined && stat.mtimeMs < cutoff) await NodeFSP.rm(file, { force: true });
    }
  }).pipe(Effect.forkScoped);

  return FileTransfer.of({ copy, serve, receive });
});

export const headers = { kind: KIND_HEADER, mode: MODE_HEADER };

export const layer = Layer.effect(FileTransfer, make);
