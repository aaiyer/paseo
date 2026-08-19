import { describe, expect, it } from "vitest";

import {
  classifyBinaryFrameKind,
  decodeBinaryFrame,
  encodeFileTransferFrame,
  encodeTerminalStreamFrame,
  FileTransferOpcode,
  TerminalStreamOpcode,
} from "./index.js";

describe("binary frame demux", () => {
  it("classifies terminal frames from only the bounded opcode discriminator", () => {
    expect(classifyBinaryFrameKind(new Uint8Array([TerminalStreamOpcode.Input]))).toBe("terminal");
    expect(classifyBinaryFrameKind(new Uint8Array([FileTransferOpcode.FileChunk]))).toBe(
      "file_transfer",
    );
    expect(classifyBinaryFrameKind(new Uint8Array())).toBeNull();
    expect(classifyBinaryFrameKind(new Uint8Array([0xff, 0xde, 0xad, 0xbe, 0xef]))).toBeNull();
  });

  it("routes terminal frames by opcode", () => {
    expect(
      decodeBinaryFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          slot: 7,
          payload: "ls",
        }),
      ),
    ).toEqual({
      kind: "terminal",
      frame: {
        opcode: TerminalStreamOpcode.Input,
        slot: 7,
        payload: new TextEncoder().encode("ls"),
      },
    });
  });

  it("routes file-transfer frames by opcode", () => {
    expect(
      decodeBinaryFrame(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileChunk,
          requestId: "req-upload",
          payload: new TextEncoder().encode("hello"),
        }),
      ),
    ).toEqual({
      kind: "file_transfer",
      frame: {
        opcode: FileTransferOpcode.FileChunk,
        requestId: "req-upload",
        payload: new TextEncoder().encode("hello"),
      },
    });
  });

  it("rejects unknown binary opcodes", () => {
    expect(decodeBinaryFrame(new Uint8Array([0xff, 0]))).toBeNull();
  });
});
