import {
  decodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "./file-transfer.js";
import {
  decodeTerminalStreamFrame,
  TerminalStreamOpcode,
  type TerminalStreamFrame,
} from "./terminal.js";

export type BinaryFrame =
  | { kind: "terminal"; frame: TerminalStreamFrame }
  | { kind: "file_transfer"; frame: FileTransferFrame };

export type BinaryFrameKind = BinaryFrame["kind"];

/** Classifies only the fixed one-byte envelope tag; it never decodes a payload. */
export function classifyBinaryFrameKind(bytes: Uint8Array): BinaryFrameKind | null {
  switch (bytes[0]) {
    case TerminalStreamOpcode.Output:
    case TerminalStreamOpcode.Input:
    case TerminalStreamOpcode.Resize:
    case TerminalStreamOpcode.Snapshot:
    case TerminalStreamOpcode.Restore:
      return "terminal";
    case FileTransferOpcode.FileBegin:
    case FileTransferOpcode.FileChunk:
    case FileTransferOpcode.FileEnd:
      return "file_transfer";
    default:
      return null;
  }
}

export function decodeBinaryFrame(bytes: Uint8Array): BinaryFrame | null {
  switch (classifyBinaryFrameKind(bytes)) {
    case "terminal": {
      const frame = decodeTerminalStreamFrame(bytes);
      return frame ? { kind: "terminal", frame } : null;
    }
    case "file_transfer": {
      const frame = decodeFileTransferFrame(bytes);
      return frame ? { kind: "file_transfer", frame } : null;
    }
    default:
      return null;
  }
}
